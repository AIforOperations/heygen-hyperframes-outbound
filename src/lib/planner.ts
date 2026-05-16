import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createMessage, extractText, type ClaudeModel } from "./anthropic";
import type { Lead } from "./scrape";

/**
 * Claude-driven scene planner.
 *
 * Reads the scene registry (compositions/registry.json) and asks Claude to
 * pick 3-5 scenes that fit the prospect's reality. Returns a plan JSON that
 * the existing composition compiler can render.
 *
 * Fallback: caller catches any thrown error and falls back to the templated
 * builder. We never want planning to fail the whole pipeline.
 */

export interface PlannerInput {
  jobId: string;
  duration: number;            // exact heygenDuration; plan total must == this
  avatarId: string;
  avatarVideoPath: string;     // absolute path on disk to the avatar.mp4
  avatarCrop: { positionY: string; scale: number; originY: string };
  lead: Lead;
  senderName: string;
  senderCompany: string;
  offer: string;
  scriptText: string;
}

export interface ScenePlan {
  compositionId: string;
  duration: number;
  avatar: {
    avatarId: string;
    videoPath: string;
    crop: { positionY: string; scale: number; originY: string };
  };
  scenes: Array<{
    id: string;
    templateId: string;
    start: number;
    duration: number;
    variables: Record<string, unknown>;
  }>;
}

const DEFAULT_MODEL: ClaudeModel = "claude-sonnet-4-6";

function loadRegistry(): string {
  const p = path.join(process.cwd(), "compositions/registry.json");
  return readFileSync(p, "utf8");
}

/**
 * Load each scene's schema and produce a Claude-friendly catalog. The
 * registry alone only tells Claude what scenes exist — it doesn't enumerate
 * the exact variable names + types each one accepts. Without this, Claude
 * invents plausible-sounding names (`greeting`, `title`, `headline`) that
 * the schema's additionalProperties:false rejects.
 */
function loadSceneCatalog(): string {
  const registryPath = path.join(process.cwd(), "compositions/registry.json");
  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
    scenes: Array<{
      id: string;
      category: string;
      description?: string;
      durationRange: [number, number];
      defaultDuration: number;
      schema: string;
      fixture: string;
    }>;
  };

  // Hackathon constraint: form-autofill-v1 has nested maxLength rules that
  // Claude routinely violates by 1-2 chars. Skip it from the catalog so
  // Claude can't pick it. Re-enable once we add value-length post-truncation.
  const SCENE_DENYLIST = new Set(["form-autofill-v1"]);

  const lines: string[] = [];
  for (const s of registry.scenes) {
    if (SCENE_DENYLIST.has(s.id)) continue;
    const schemaPath = path.join(process.cwd(), "compositions", s.schema);
    const fixturePath = path.join(process.cwd(), "compositions", s.fixture);
    let fixtureJson = "{}";
    let schema: { required?: string[] } = {};
    try {
      schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    } catch {
      /* skip */
    }
    try {
      fixtureJson = readFileSync(fixturePath, "utf8").trim();
    } catch {
      /* skip */
    }
    lines.push(`--- ${s.id} (${s.category}) — duration ${s.durationRange[0]}-${s.durationRange[1]}s, default ${s.defaultDuration}s ---`);
    if (s.description) lines.push(s.description);
    if (schema.required?.length) {
      lines.push(`required variables: ${schema.required.join(", ")}`);
    }
    // The fixture is a WORKING example — mirror its exact shape including
    // nested arrays/objects. additionalProperties:false in the schemas
    // means any extra key fails validation.
    lines.push("working example (variables block — match key names + nesting EXACTLY):");
    lines.push(fixtureJson);
    lines.push("");
  }
  return lines.join("\n");
}

function buildSystemPrompt(): string {
  return `You design HyperFrames scene plans for short personalized outbound videos.

You will be given:
- A scene registry: 7 reusable templates with duration ranges and required variables
- A prospect (name, role, company, website, recent posts/hooks)
- The script the avatar will speak
- The exact video duration in seconds

Your job: produce a STRICT JSON plan that the compiler can render. The plan picks 3-5 scenes from the registry and times them across the avatar video. Scene order should follow the script's narrative beats.

RULES (the compiler will reject invalid plans)
1. Output ONLY valid JSON. No markdown, no commentary, no code fences.
2. Top-level keys: compositionId, duration, avatar, scenes (array of 3-5 scenes).
3. compositionId: lowercase, alphanumeric + dashes + underscores only (3-80 chars).
4. duration: number, must EXACTLY equal the requested video duration to one decimal.
5. avatar: pass through avatarId, videoPath, crop verbatim from the user message.
6. Each scene must have: id (lowercase, alphanumeric + dashes), templateId (must be in the registry), start (seconds), duration (seconds), variables (object).
7. Each scene's duration MUST be within the template's durationRange.
8. Scenes must be contiguous: scene[0].start = 0, scene[i+1].start = scene[i].start + scene[i].duration. Last scene's end MUST equal plan.duration exactly.
9. Use each scene's required variables (see registry); supply optional ones when they add value.
10. Variables must be specific to the prospect — pull from the lead data (company name, role, recent posts, website hero text, headlines). Never invent stats you can't ground.

SCENE SELECTION GUIDANCE
- intro-v1: ALWAYS start with this. Greeting + company card.
- headline-pull-v1: Best for an observational hook — a quote from the prospect's posts, a website hero line, a friction statement.
- stat-callout-v1: ONLY if there is a real number from the prospect's data (years in business, headcount, turnaround time). Don't fabricate.
- chart-comparison-v1: ONLY if you can ground both rows (e.g. "manual N hours" vs "with us, N min"). If you can't ground both, skip.
- form-autofill-v1: Use when the offer involves filling out forms / documents (DRE PDFs, contracts, intake forms).
- cta-card-v1: ALWAYS end with this. Make it a REPLY CTA — the cta_headline is a short hero ask (3-6 words: "Reply with yes.", "Want in?", "Sound good?"), and cta_subline is the specific follow-up with timing + no-risk language (e.g. "I'll have it live by Thursday. No contract."). NEVER include a fake email or URL — the prospect replies to the message the video is embedded in. NEVER use the cta_headline "Just say yes." literally — vary it per script.
- transition-v1: Optional brief breath between two heavy scenes.

DURATION CARVING
- intro-v1: typically 4-6s
- headline-pull-v1: typically 6-12s
- stat-callout-v1: typically 4-7s
- chart-comparison-v1: typically 6-10s
- form-autofill-v1: typically 6-10s
- cta-card-v1: typically 4-8s
- Adjust to fit the exact total duration.

WRITING THE VARIABLE TEXT
- Plain English. No filler. No "elevate", "transformative", "streamline", "leverage", etc.
- Lift phrases from the prospect's own world (their website hero, their posts, their headline).
- Eyebrows are short (≤24 chars). Headlines are punchy, one sentence each.
- For chart bars: use realistic values. "value_percent" controls width (0-100).
- For company logo fallbacks: 2-3 letter initials, hex color that contrasts the cream background.`;
}

function buildUserMessage(input: PlannerInput, catalog: string): string {
  const lead = input.lead;
  const hooks = (lead.hooks ?? []).slice(0, 3).map((h, i) => {
    const text = (h.text || "").slice(0, 320).replace(/\s+/g, " ").trim();
    return `  [${i + 1}] (${h.type}) ${text}`;
  }).join("\n") || "  (no recent posts available)";
  const website = lead.website;

  const lines: string[] = [];
  lines.push("SCENE CATALOG (use EXACT variable names; the compiler rejects unknown keys)");
  lines.push(catalog);
  lines.push("");
  lines.push("AVATAR (pass these through verbatim into plan.avatar)");
  lines.push(JSON.stringify({
    avatarId: input.avatarId,
    videoPath: input.avatarVideoPath,
    crop: input.avatarCrop,
  }, null, 2));
  lines.push("");
  lines.push("EXACT VIDEO DURATION (plan.duration must equal this)");
  lines.push(`${input.duration} seconds`);
  lines.push("");
  lines.push("COMPOSITION ID (use this as plan.compositionId)");
  lines.push(`lf-${input.jobId}`.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 80));
  lines.push("");
  lines.push("SENDER");
  lines.push(`- Name: ${input.senderName}`);
  lines.push(`- Company: ${input.senderCompany}`);
  lines.push("");
  lines.push("OFFER (use to shape the headline-pull and cta scenes)");
  lines.push(input.offer.slice(0, 600));
  lines.push("");
  lines.push("SCRIPT THE AVATAR SPEAKS (use to align scene timing with narrative)");
  lines.push(input.scriptText.slice(0, 1500));
  lines.push("");
  lines.push("PROSPECT");
  lines.push(`- First name: ${lead.firstName ?? lead.fullName ?? "(unknown)"}`);
  if (lead.role) lines.push(`- Role: ${lead.role}`);
  if (lead.company?.name) lines.push(`- Company: ${lead.company.name}`);
  if (lead.company?.websiteUrl) lines.push(`- Website: ${lead.company.websiteUrl}`);
  if (lead.company?.logoUrl) lines.push(`- Company logo URL: ${lead.company.logoUrl}`);
  if (lead.headline) lines.push(`- LinkedIn headline: ${lead.headline}`);
  if (lead.tenureMonths != null) {
    const yrs = (lead.tenureMonths / 12).toFixed(1);
    lines.push(`- Tenure in current role: ${lead.tenureMonths} months (~${yrs} years)`);
  }
  lines.push("");
  lines.push("RECENT POSTS / ACTIVITY (use as hook material)");
  lines.push(hooks);
  lines.push("");
  if (website) {
    lines.push("PROSPECT COMPANY WEBSITE");
    if (website.heroText) lines.push(`- Hero: ${website.heroText}`);
    if (website.headings?.length) lines.push(`- Headings: ${website.headings.slice(0, 10).join(" | ")}`);
    if (website.bodyExcerpt) lines.push(`- About: ${website.bodyExcerpt.slice(0, 600)}`);
    lines.push("");
  }
  lines.push("Produce the plan JSON now. Output JSON ONLY.");
  return lines.join("\n");
}

function extractJson(text: string): unknown {
  // Strip code fences if Claude returned them despite instructions.
  let s = text.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  }
  // Find the outermost {...} substring in case Claude added prose.
  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    s = s.slice(firstBrace, lastBrace + 1);
  }
  return JSON.parse(s);
}

export async function generateScenePlan(input: PlannerInput): Promise<ScenePlan> {
  void loadRegistry; // kept for future use; catalog is what Claude actually needs
  const catalog = loadSceneCatalog();
  const system = buildSystemPrompt();
  const user = buildUserMessage(input, catalog);

  const resp = await createMessage({
    model: DEFAULT_MODEL,
    maxTokens: 2400,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
  });
  const raw = extractText(resp);
  // Hackathon-only: log Claude's raw plan so we can debug schema mismatches.
  console.log("[planner] Claude raw output (first 4kB):", raw.slice(0, 4000));
  const plan = extractJson(raw) as ScenePlan;

  // Sanity-fix a couple of fields the compiler is strict about. The compiler
  // does the full validation; this is just for things Claude commonly drifts
  // on (locking compositionId + avatar values to the requested ones).
  plan.compositionId = `lf-${input.jobId}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 80);
  plan.avatar = {
    avatarId: input.avatarId,
    videoPath: input.avatarVideoPath,
    crop: input.avatarCrop,
  };
  // Round duration to 1 decimal to match the carving precision elsewhere
  plan.duration = Math.round(input.duration * 10) / 10;

  // Sanitize scene timing: Claude routinely picks durations outside the
  // scene's [min, max] range or leaves gaps. Re-clamp + re-sequence so the
  // compiler's validation passes. We may shrink plan.duration if the sum
  // of clamped scene durations is less than the target — acceptable
  // (trailing avatar audio gets trimmed by the renderer).
  sanitizeScheduling(plan);

  // Drop dead logo URLs so the scenes render their initials-fallback path
  // instead of a broken-image placeholder. Add hosts as we discover dead
  // providers (Clearbit's free logo API was deprecated).
  scrubDeadLogoUrls(plan);

  return plan;
}

const DEAD_LOGO_HOSTS = ["logo.clearbit.com", "clearbit.com"];

function scrubDeadLogoUrls(plan: ScenePlan): void {
  for (const scene of plan.scenes) {
    const vars = scene.variables;
    for (const key of Object.keys(vars)) {
      if (!/logo|image/i.test(key)) continue;
      const v = vars[key];
      if (typeof v !== "string") continue;
      try {
        const host = new URL(v).hostname.toLowerCase();
        if (DEAD_LOGO_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
          vars[key] = "";
        }
      } catch {
        // not a URL — leave it alone
      }
    }
  }
}

// Scene duration ranges from compositions/registry.json. Hardcoded here
// because re-reading the registry inside a tight sanitize loop is overkill
// for the hackathon. Keep in sync if registry changes.
const SCENE_DURATION_RANGES: Record<string, [number, number]> = {
  "intro-v1": [3, 8],
  "stat-callout-v1": [4, 11],
  "headline-pull-v1": [4, 15],
  "chart-comparison-v1": [5, 12],
  "form-autofill-v1": [6, 12],
  "cta-card-v1": [3, 10],
  "transition-v1": [1, 3],
};

function sanitizeScheduling(plan: ScenePlan): void {
  let cursor = 0;
  for (const scene of plan.scenes) {
    const range = SCENE_DURATION_RANGES[scene.templateId];
    if (range) {
      scene.duration = clamp(scene.duration, range[0], range[1]);
    }
    scene.duration = Math.round(scene.duration * 10) / 10;
    scene.start = Math.round(cursor * 10) / 10;
    cursor += scene.duration;
  }
  // The compiler requires plan.duration === scenes' total. If the requested
  // target exceeds the sum, lower the plan duration; trailing avatar audio
  // gets trimmed. If sum exceeds target, expand plan duration (the renderer
  // pads the avatar's final frame).
  plan.duration = Math.round(cursor * 10) / 10;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
