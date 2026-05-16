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

OUTPUT CONTRACT (strict — server rejects invalid plans)
1. Output ONLY valid JSON. No markdown, no commentary, no code fences.
2. Top-level keys: compositionId, duration, avatar, scenes (array of 3-5 scenes).
3. compositionId: lowercase, alphanumeric + dashes + underscores only (3-80 chars).
4. duration: number, must EXACTLY equal the requested video duration to one decimal.
5. avatar: pass through avatarId, videoPath, crop verbatim from the user message.
6. Each scene object: id (lowercase, alphanumeric + dashes), templateId, start, duration, variables, an optional transitionInto field (see SCENE TRANSITIONS below), AND a required \`bound_sentence\` field (see #7).
7. **bound_sentence**: a SUBSTRING (≥18 chars) of the SCRIPT THE AVATAR SPEAKS that this scene visualizes. The server checks this is actually present in the script. This is the contract that anchors every scene's content to spoken words — pick the sentence (or run of two sentences) the scene is visually narrating. Each scene gets exactly one bound_sentence; sentences should appear in order across scenes.
8. Each scene's duration MUST be within the template's durationRange.
9. Scenes must be contiguous: scene[0].start = 0, scene[i+1].start = scene[i].start + scene[i].duration. Last scene's end MUST equal plan.duration exactly.
10. **Grounding rule**: every textual variable in a scene's variables block must draw from the bound_sentence's content OR from the offer/prospect data referenced by that sentence. Never invent numbers, claims, or quotes that the avatar doesn't say or imply.

THE BIG IDEA: each scene VISUALIZES what the avatar is saying RIGHT THEN. The avatar speaks 4-7 sentences in 30 seconds; each gets one scene that illustrates its content. A stat-callout next to a sentence about "missed calls" should show a missed-call number, not the prospect's tenure. A chart-comparison next to a sentence about response time should chart response time, not made-up metrics.

SCENE TRANSITIONS

Each scene also has an optional transitionInto field that picks how that scene enters from the previous one. The compiler runs a 0.45s enter animation on the scene wrapper using the chosen style. Options:

- "fade" — soft cross-fade. Default. Always use for the FIRST scene (no previous scene to transition from).
- "whip-pan" — horizontal slide with motion blur. Use between fast-paced narrative beats (intro→headline, headline→stat).
- "cross-warp-morph" — scale + slight rotation + blur. Use between data beats (stat→past-work-chart, chart-comparison→cta).
- "cinematic-zoom" — slight push-in. ALWAYS use as the transitionInto for the CTA scene — it earns the close.
- "flash-through-white" — bright white flash. Use SPARINGLY (max once per video, between scenes with very different visual weight).
- "light-leak" — warm orange-red bloom sweep. Use SPARINGLY (max once per video), as a "moment" between a problem-stating scene and a solution-stating scene.

Rules:
- Never use the same transition twice in a row (whip-pan → whip-pan is jarring).
- "flash-through-white" and "light-leak" together: max once per video each. Don't stack them.
- First scene: transitionInto = "fade".
- Last scene (cta-card-v1): transitionInto = "cinematic-zoom" by default.
- Middle scenes: alternate between "whip-pan" and "cross-warp-morph" unless one of the special styles fits a specific narrative moment.

SCENE SELECTION GUIDANCE
- intro-v1: ALWAYS start with this. Greeting + company card.
- headline-pull-v1: Best for an observational hook — a quote from the prospect's posts, a website hero line, a friction statement.
- stat-callout-v1: ONLY if there is a real number from the prospect's data (years in business, headcount, turnaround time). Don't fabricate.
- past-work-chart-v1: Use ONCE per video as a credibility beat (~middle of the script, right before or after the offer). Show a plausible prior result for a similar business in their vertical. Pick concrete units ($K recovered, % more booked, hours saved per week, leads per month). Generate plausible-but-not-absurd values that match the script's claim. Use claim_who to anchor the number to a comparable business type ("Austin HVAC contractor", "12-stylist salon", "regional dental group") — never name a real company unless we actually worked with them. Skip if the script doesn't mention or imply prior outcomes.
- chart-comparison-v1: ONLY if you can ground both rows (e.g. "manual N hours" vs "with us, N min"). If you can't ground both, skip.
- form-autofill-v1: Use when the offer involves filling out forms / documents (DRE PDFs, contracts, intake forms).
- cta-card-v1: ALWAYS end with this. Make it a REPLY CTA — the cta_headline is a short hero ask (3-6 words: "Reply with yes.", "Want in?", "Sound good?"), and cta_subline is the specific follow-up with timing + no-risk language (e.g. "I'll have it live by Thursday. No contract."). NEVER include a fake email or URL — the prospect replies to the message the video is embedded in. NEVER use the cta_headline "Just say yes." literally — vary it per script.
- transition-v1: Optional brief breath between two heavy scenes.

DURATION CARVING
- intro-v1: typically 4-6s
- headline-pull-v1: typically 6-12s
- stat-callout-v1: typically 4-7s
- past-work-chart-v1: typically 5-8s (needs time for the number to tick up + claim to land)
- chart-comparison-v1: typically 6-10s
- form-autofill-v1: typically 6-10s
- cta-card-v1: typically 4-8s
- Adjust to fit the exact total duration.

WRITING THE VARIABLE TEXT
- Plain English. No filler. No "elevate", "transformative", "streamline", "leverage", "robust", "seamless", "comprehensive", "harness", "synergy", "actionable", "proactive", "next-level".
- Lift phrases from the bound_sentence and the prospect's own world (website hero, posts, headline).
- Eyebrows are short (≤24 chars). Headlines are punchy, one sentence each.
- For chart bars: use realistic values. "value_percent" controls width (0-100). For "lower-is-better" metrics (e.g., response time), set value_percent INVERSELY — the good outcome should have the visually appropriate bar size.
- For company logo fallbacks: 2-3 letter initials, hex color that contrasts the cream background.
- For past-work-chart-v1: result_value should be a plausible round-ish number that matches the script's claim's scale ($K not $M, 30-90% not 99%, single/double-digit hours/leads not thousands). claim_who anchors to a comparable business TYPE, never a real famous company name.

EXAMPLE of a well-grounded scene from a 30s script about a roofer's missed calls:
  Avatar sentence: "Ace Roofing gets a solid volume of inbound calls, and every missed one is a job that probably went to a competitor down the street."
  Bad scene (ungrounded): stat-callout-v1 showing "33 mo" (the prospect's tenure — unrelated to the sentence)
  Good scene (grounded): headline-pull-v1 with eyebrow "Inbound traffic", headline "Every missed call is a job lost to a competitor.", footnote "aceroofingtexas.com"
  ALSO acceptable: past-work-chart-v1 with eyebrow "Prior result", result_prefix "$", result_value 48, result_suffix "K", claim_headline "Recovered in missed-lead revenue, first 30 days.", claim_who "Texas roofing contractor, 8-truck fleet"`;
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

// Each scene Claude emits carries an extra `bound_sentence` field that the
// server uses for grounding validation. We strip it before returning the
// plan to the compiler (which would reject unknown fields).
type SceneWithBinding = ScenePlan["scenes"][number] & { bound_sentence?: string };

const THINKING_BUDGET_TOKENS = 4096;
const MAX_OUTPUT_TOKENS = 6400; // must exceed thinking budget

export async function generateScenePlan(input: PlannerInput): Promise<ScenePlan> {
  void loadRegistry; // kept for future use; catalog is what Claude actually needs
  const catalog = loadSceneCatalog();
  const system = buildSystemPrompt();
  const user = buildUserMessage(input, catalog);

  const resp = await createMessage({
    model: DEFAULT_MODEL,
    maxTokens: MAX_OUTPUT_TOKENS,
    // Extended thinking gives the model room to reason about which sentence
    // each scene should bind to and what variables make sense, BEFORE
    // committing to JSON. Costs ~$0.02 extra per video, dramatically
    // improves grounding quality.
    thinking: { type: "enabled", budget_tokens: THINKING_BUDGET_TOKENS },
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
  });
  const raw = extractText(resp);
  console.log("[planner] Claude raw output (first 4kB):", raw.slice(0, 4000));
  const plan = extractJson(raw) as ScenePlan & { scenes: SceneWithBinding[] };

  // Sanity-fix fields the compiler is strict about.
  plan.compositionId = `lf-${input.jobId}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 80);
  plan.avatar = {
    avatarId: input.avatarId,
    videoPath: input.avatarVideoPath,
    crop: input.avatarCrop,
  };
  plan.duration = Math.round(input.duration * 10) / 10;

  // Validate each scene against its bound_sentence + content rules. Failed
  // scenes get ONE targeted retry — much cheaper than full re-plan and
  // typically clears the failure.
  await validateAndRepairScenes(plan, input);

  // Existing post-processing: clamp durations, re-sequence starts.
  sanitizeScheduling(plan);
  // Drop dead logo URLs so scenes render the initials fallback.
  scrubDeadLogoUrls(plan);

  // Strip bound_sentence from each scene — the compiler doesn't allow
  // unknown fields. Keep it in a sidecar log for observability.
  const boundSentences: Array<{ sceneId: string; sentence: string }> = [];
  for (const scene of plan.scenes as SceneWithBinding[]) {
    if (scene.bound_sentence) {
      boundSentences.push({ sceneId: scene.id, sentence: scene.bound_sentence });
      delete scene.bound_sentence;
    }
  }
  if (boundSentences.length) {
    console.log("[planner] scene grounding:", JSON.stringify(boundSentences, null, 2));
  }

  return plan;
}

// ---------- Validation + repair ----------

interface ValidationFailure {
  sceneIndex: number;
  scene: SceneWithBinding;
  reasons: string[];
}

/**
 * Walk every scene, check it against its bound_sentence and content rules.
 * Any scene that fails gets one focused retry call: server re-prompts Claude
 * with JUST that scene's slot, providing the failure reasons + the relevant
 * sentence, and asks for fresh variables only.
 */
async function validateAndRepairScenes(
  plan: ScenePlan & { scenes: SceneWithBinding[] },
  input: PlannerInput
): Promise<void> {
  const failures: ValidationFailure[] = [];
  for (let i = 0; i < plan.scenes.length; i++) {
    const scene = plan.scenes[i];
    const reasons = validateScene(scene, input.scriptText);
    if (reasons.length) failures.push({ sceneIndex: i, scene, reasons });
  }
  if (!failures.length) return;

  console.warn(
    `[planner] ${failures.length} scene(s) failed validation, retrying: ` +
      failures.map((f) => `${f.scene.id}: ${f.reasons.join("; ")}`).join(" | ")
  );

  // Retry each failed scene in parallel — small focused prompts.
  await Promise.all(
    failures.map(async (f) => {
      try {
        const repaired = await repairScene(f, input);
        if (repaired) {
          plan.scenes[f.sceneIndex] = {
            ...plan.scenes[f.sceneIndex],
            ...repaired,
          };
        }
      } catch (err) {
        console.warn(
          `[planner] repair failed for ${f.scene.id}, keeping original: ` +
            (err instanceof Error ? err.message : String(err))
        );
      }
    })
  );
}

const BANNED_PHRASES = [
  // AI-tell filler words. Server rejects scene variables containing these.
  /\bleverage\b/i,
  /\btransformative\b/i,
  /\bstreamline\b/i,
  /\bseamless(ly)?\b/i,
  /\brobust\b/i,
  /\bcomprehensive\b/i,
  /\bharness\b/i,
  /\bsynerg(y|ies)\b/i,
  /\bactionable\b/i,
  /\bproactive\b/i,
  /\bnext-?level\b/i,
  /\bvibrant\b/i,
  /\belevate\b/i,
];

const FAMOUS_BRAND_NAMES = [
  // Don't let past-work claims piggy-back on famous brands.
  "stripe", "shopify", "airbnb", "uber", "lyft", "doordash", "instacart",
  "google", "facebook", "meta", "apple", "amazon", "microsoft", "netflix",
  "tesla", "openai", "anthropic", "salesforce", "hubspot", "notion",
  "linear", "vercel", "figma",
];

function validateScene(scene: SceneWithBinding, scriptText: string): string[] {
  const reasons: string[] = [];

  // 1. bound_sentence presence + script substring check
  const bs = (scene.bound_sentence || "").trim();
  if (!bs) {
    reasons.push("missing bound_sentence");
  } else if (bs.length < 18) {
    reasons.push(`bound_sentence too short (${bs.length} chars, need >=18)`);
  } else {
    const normalizedScript = scriptText.toLowerCase().replace(/\s+/g, " ");
    const normalizedBs = bs.toLowerCase().replace(/\s+/g, " ");
    const probe = normalizedBs.slice(0, Math.min(40, normalizedBs.length));
    if (!normalizedScript.includes(probe)) {
      reasons.push(`bound_sentence "${bs.slice(0, 60)}..." not found in script`);
    }
  }

  // 2. Banned phrases anywhere in variable text
  const allText = JSON.stringify(scene.variables || {});
  for (const re of BANNED_PHRASES) {
    if (re.test(allText)) {
      reasons.push(`banned phrase matched: ${re.source}`);
    }
  }

  // 3. Per-template grounding rules
  const tpl = scene.templateId;
  const v = (scene.variables ?? {}) as Record<string, unknown>;

  if (tpl === "cta-card-v1") {
    const headline = String(v.cta_headline || "");
    if (/^just say yes\.?$/i.test(headline)) {
      reasons.push("cta_headline is the banned default 'Just say yes.'");
    }
  }

  if (tpl === "past-work-chart-v1") {
    const value = Number(v.result_value);
    if (!Number.isFinite(value) || value <= 0) {
      reasons.push(`result_value invalid: ${String(v.result_value)}`);
    }
    if (value > 10000) {
      reasons.push(`result_value implausibly large: ${value}`);
    }
    const claimWho = String(v.claim_who || "").toLowerCase();
    for (const brand of FAMOUS_BRAND_NAMES) {
      if (claimWho.includes(brand)) {
        reasons.push(`claim_who references famous brand "${brand}"`);
        break;
      }
    }
  }

  if (tpl === "chart-comparison-v1") {
    const rows = Array.isArray(v.rows) ? (v.rows as Array<Record<string, unknown>>) : [];
    if (rows.length < 2) {
      reasons.push(`chart-comparison-v1 needs >=2 rows, got ${rows.length}`);
    } else {
      const labels = rows.map((r) => String(r.label || "").toLowerCase().trim());
      const values = rows.map((r) => String(r.value_display || "").toLowerCase().trim());
      if (new Set(labels).size < labels.length) {
        reasons.push("chart-comparison-v1 has duplicate row labels");
      }
      if (new Set(values).size < values.length) {
        reasons.push("chart-comparison-v1 has duplicate row values");
      }
    }
  }

  if (tpl === "stat-callout-v1") {
    const statValue = String(v.stat_value || v.value || "");
    // The numeric part of the stat should appear somewhere in the script
    // OR be derivable from data the avatar referenced (tenure, headcount).
    // Loose check: the first run of digits in stat_value should appear in
    // the script text. Skips if stat_value has no digits at all.
    const digits = statValue.match(/\d+/);
    if (digits) {
      const normalizedScript = scriptText.toLowerCase();
      if (!normalizedScript.includes(digits[0])) {
        reasons.push(
          `stat-callout-v1 value "${statValue}" doesn't appear in script (likely fabricated)`
        );
      }
    }
  }

  return reasons;
}

async function repairScene(
  failure: ValidationFailure,
  input: PlannerInput
): Promise<Partial<SceneWithBinding> | null> {
  const { scene, reasons } = failure;
  const repairSystem = [
    "You are repairing ONE scene in a HyperFrames sales-video plan.",
    "",
    "You will be given:",
    "- The script the avatar speaks (full text)",
    "- The scene's templateId and current (rejected) variables",
    "- The reasons the scene was rejected",
    "- The bound_sentence that scene should visualize",
    "",
    "Your job: produce REPLACEMENT variables for this single scene, fixing the",
    "listed reasons. Output JSON ONLY: {\"bound_sentence\": \"...\", \"variables\": {...}}.",
    "",
    "Rules:",
    "- bound_sentence must be a verbatim >=18-char substring of the script.",
    "- Every textual variable must draw from the bound_sentence's content or",
    "  the offer/prospect data referenced by that sentence.",
    "- No filler words (leverage, transformative, streamline, seamless, robust,",
    "  etc.). No fabricated numbers. No real famous brand names in claim_who.",
    "- Match the scene's existing variable schema exactly: same keys, same types.",
  ].join("\n");

  const repairUser = [
    "SCRIPT THE AVATAR SPEAKS:",
    input.scriptText,
    "",
    `SCENE TEMPLATE: ${scene.templateId}`,
    `CURRENT bound_sentence: "${scene.bound_sentence || "(missing)"}"`,
    `CURRENT VARIABLES: ${JSON.stringify(scene.variables, null, 2)}`,
    "",
    "REJECTION REASONS:",
    ...reasons.map((r) => `- ${r}`),
    "",
    "OFFER (for grounding context):",
    input.offer.slice(0, 400),
    "",
    'Output JSON ONLY: {"bound_sentence": "...", "variables": {...}}',
  ].join("\n");

  const resp = await createMessage({
    model: DEFAULT_MODEL,
    maxTokens: 1200,
    system: repairSystem,
    messages: [{ role: "user", content: repairUser }],
  });
  const raw = extractText(resp);
  const parsed = extractJson(raw) as {
    bound_sentence?: string;
    variables?: Record<string, unknown>;
  };
  if (!parsed.variables) return null;
  return {
    bound_sentence: parsed.bound_sentence,
    variables: parsed.variables,
  };
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
  "past-work-chart-v1": [4, 9],
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
