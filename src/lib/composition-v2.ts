import "server-only";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CURATED_AVATARS } from "./avatars";
import type { Lead } from "./scrape";
import { collectCompositionFiles, type SandboxFile } from "./composition-files";
import { generateScenePlan } from "./planner";
import type { ElevenLabsWord } from "./elevenlabs";
// Static relative import — Next.js / Turbopack can resolve this at build
// time. The .mjs uses Ajv internally; that's why we added ajv + ajv-formats
// to package.json. compileComposition still reads compositions/registry.json
// at runtime from process.cwd().
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — .mjs has no .d.ts; typed via CompileFn cast below.
import { compileComposition as compileCompositionMjs } from "../../scripts/lib/composition-compiler.mjs";

interface CompileFn {
  (args: {
    repoRoot: string;
    plan: unknown;
    outDir: string;
    branding?: { senderName?: string; senderCompany?: string };
    wordTimestamps?: ElevenLabsWord[];
  }): {
    outDir: string;
    scenes: number;
    durationS: number;
  };
}
const compileComposition = compileCompositionMjs as CompileFn;

/**
 * Server-side wrapper around the new scene-based HyperFrames compiler at
 * scripts/lib/composition-compiler.mjs.
 *
 * The compiler was designed as a CLI: it reads scenes/registry from disk and
 * writes a compiled directory to disk. We:
 *   1. Build a plan JSON from the job's lead + sender data
 *   2. Write the avatar MP4 to /tmp/<jobId>/avatar.mp4
 *   3. Invoke the compiler with that plan + outDir = /tmp/<jobId>/comp/
 *   4. Walk the output dir back into a SandboxFile[] for renderInSandbox()
 *
 * Why dynamic import + createRequire: the compiler is .mjs and lives under
 * scripts/, outside the Next.js TypeScript build graph. Importing it via
 * createRequire keeps it out of the bundler's module resolution but works
 * at runtime on both local Node and Vercel's serverless function runtime.
 */

export interface CompositionV2Input {
  jobId: string;
  mp4: Buffer;
  duration: number;
  avatarId: string;
  lead: Lead;
  senderName: string;
  senderCompany: string;
  scriptText?: string;
  offer?: string;
  /** Word-level timestamps from ElevenLabs Scribe. When present, the
   *  compiler emits a bottom-right captions track timed to these. */
  wordTimestamps?: ElevenLabsWord[];
}

export async function buildCompositionV2(input: CompositionV2Input): Promise<SandboxFile[]> {
  const workDir = await fs.mkdtemp(path.join(tmpdir(), `lf-comp-${input.jobId}-`));
  const avatarMp4Path = path.join(workDir, "avatar.mp4");
  const outDir = path.join(workDir, "comp");

  // Write the avatar MP4 once; the compiler copyFileSyncs it into the
  // composition's assets/ dir.
  await fs.writeFile(avatarMp4Path, input.mp4);

  // Build the plan. Prefer Claude-generated (smarter scene selection,
  // grounded variables); fall back to the deterministic 3-scene template
  // if Claude errors or returns invalid JSON.
  const avatar = CURATED_AVATARS.find((a) => a.id === input.avatarId);
  const crop = avatar?.crop ?? { positionY: "30%", scale: 1.0, originY: "30%" };

  let plan: unknown;
  try {
    plan = await generateScenePlan({
      jobId: input.jobId,
      duration: input.duration,
      avatarId: input.avatarId,
      avatarVideoPath: avatarMp4Path,
      avatarCrop: crop,
      lead: input.lead,
      senderName: input.senderName,
      senderCompany: input.senderCompany,
      offer: input.offer ?? "",
      scriptText: input.scriptText ?? "",
    });
  } catch (err) {
    console.warn("[composition-v2] Claude planner failed, falling back to template:", err instanceof Error ? err.message : err);
    plan = buildPlanFromLead({
      jobId: input.jobId,
      duration: input.duration,
      avatarId: input.avatarId,
      avatarMp4Path,
      lead: input.lead,
      senderName: input.senderName,
      senderCompany: input.senderCompany,
      scriptText: input.scriptText,
    });
  }

  // Invoke the compiler. `repoRoot` tells it where to find
  // compositions/registry.json + scenes/ + _shared/ at runtime. On Vercel
  // process.cwd() is the function root which contains the deployed project
  // tree (including compositions/ after .vercelignore was updated).
  const repoRoot = process.cwd();
  compileComposition({
    repoRoot,
    plan,
    outDir,
    branding: {
      senderName: input.senderName,
      senderCompany: input.senderCompany,
    },
    wordTimestamps: input.wordTimestamps,
  });

  // Walk the compiled directory back into in-memory SandboxFile[].
  const files = await collectCompositionFiles(outDir);

  // Best-effort cleanup of the tmp dir (don't fail rendering on cleanup error).
  fs.rm(workDir, { recursive: true, force: true }).catch(() => {});

  return files;
}

// ---------- Plan builder ----------

interface PlanBuilderInput {
  jobId: string;
  duration: number;
  avatarId: string;
  avatarMp4Path: string;
  lead: Lead;
  senderName: string;
  senderCompany: string;
  scriptText?: string;
}

function buildPlanFromLead(opts: PlanBuilderInput) {
  const avatar = CURATED_AVATARS.find((a) => a.id === opts.avatarId);
  const crop = avatar?.crop ?? { positionY: "30%", scale: 1.0, originY: "30%" };

  const lead = opts.lead;
  const firstName = lead.firstName ?? lead.fullName?.split(" ")[0] ?? "there";
  const fullName = lead.fullName ?? firstName;
  const companyName = lead.company?.name ?? "your team";
  const role = lead.role ?? "decision-maker";

  // Carve the duration across 3 scenes. The compiler enforces both per-scene
  // min/max ranges AND that scene ends sum exactly to plan.duration. We use
  // the longest middle scene (headline-pull) as our slack and clamp the
  // others. plan.duration is set to the actual sum afterwards — if heygen
  // ran longer than the carving allows (max 33s with 3 scenes), the trailing
  // avatar audio gets clipped, which is acceptable for now.
  //
  // Ranges from compositions/registry.json:
  //   intro-v1:         [3, 8]
  //   headline-pull-v1: [4, 15]
  //   cta-card-v1:      [3, 10]
  const carve = carveDurations(opts.duration);
  const introD = carve.intro;
  const pullD = carve.pull;
  const ctaD = carve.cta;
  const planTotal = round1(introD + pullD + ctaD);

  const introStart = 0;
  const pullStart = introD;
  const ctaStart = introD + pullD;

  // The "headline" for the pull-quote scene is the single most personal,
  // observational line we can pull from the data. Order of preference:
  //   1. First recent post's text (clear, specific, dated)
  //   2. Website hero text (what the company does)
  //   3. Lead headline (their own bio line)
  //   4. Fallback to a generic observation
  const headline = pickHeadline(lead);
  const highlight = pickHighlight(headline);
  const headlineEyebrow = lead.hooks?.length ? "From your feed" : "What I noticed";
  const headlineFootnote = lead.company?.websiteUrl
    ? domainFromUrl(lead.company.websiteUrl)
    : companyName;

  const senderInitial = (opts.senderName || "L").trim()[0]?.toUpperCase() ?? "L";

  return {
    compositionId: `lf-${opts.jobId}`.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 80),
    duration: planTotal,
    avatar: {
      avatarId: opts.avatarId,
      // The compiler resolves videoPath relative to repoRoot; an absolute path
      // resolves to itself.
      videoPath: opts.avatarMp4Path,
      crop,
    },
    scenes: [
      {
        id: "s1-intro",
        templateId: "intro-v1",
        start: round1(introStart),
        duration: round1(introD),
        variables: {
          prospect_name: firstName,
          prospect_company: companyName,
          prospect_company_descriptor: role,
          sender_name: opts.senderName,
          sender_company: opts.senderCompany,
          company_logo_url: lead.company?.logoUrl ?? "",
          company_logo_fallback_text: initials(companyName),
          company_logo_fallback_color: "#1f3a5f",
        },
      },
      {
        id: "s2-pull",
        templateId: "headline-pull-v1",
        start: round1(pullStart),
        duration: round1(pullD),
        variables: {
          eyebrow: headlineEyebrow,
          headline,
          highlight,
          footnote: headlineFootnote,
        },
      },
      {
        id: "s3-cta",
        templateId: "cta-card-v1",
        start: round1(ctaStart),
        duration: round1(ctaD),
        variables: {
          eyebrow: "Quick reply",
          cta_headline: "Reply with yes.",
          cta_subline: `I'll get this set up for ${companyName} this week. No commitment.`,
          sender_name: opts.senderName,
          sender_company: opts.senderCompany,
        },
      },
    ],
  };

  void senderInitial; // currently unused; reserved for future scenes
}

// ---------- Helpers ----------

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * Allocate a target total duration across the three scenes we use, respecting
 * each scene's min/max range. Returns the actual sum used (may be ≤ target
 * when target exceeds the max-sum of 33s = 8 + 15 + 10).
 */
function carveDurations(target: number): { intro: number; pull: number; cta: number } {
  // 1. Pull takes as much slack as possible
  const pull = clamp(target * 0.5, 4, 15);
  // 2. Split the remainder ~40/60 between intro and cta
  const remaining = Math.max(0, target - pull);
  let intro = clamp(remaining * 0.4, 4, 8);
  let cta = clamp(remaining - intro, 5, 10);
  // 3. If cta hit its cap but there's still time left in intro head room,
  //    shift the leftover into intro to minimize total clipping.
  const used = intro + cta + pull;
  if (used < target && intro < 8) {
    const headroom = 8 - intro;
    const need = target - used;
    intro = round1(intro + Math.min(headroom, need));
  }
  // 4. Round all to 0.1s for clean numbers
  return { intro: round1(intro), pull: round1(pull), cta: round1(cta) };
}

function initials(s: string | null | undefined): string {
  if (!s) return "LF";
  const parts = s.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "LF";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function domainFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function pickHeadline(lead: Lead): string {
  const hook = lead.hooks?.[0];
  if (hook?.text) {
    // Trim to a single-clause pull-quote. The scene renders at very large
    // type; we want at most ~120 chars so it doesn't blow out the layout.
    const cleaned = hook.text.replace(/\s+/g, " ").trim();
    const firstSentence = cleaned.match(/^[^.!?\n]+[.!?]?/)?.[0] ?? cleaned;
    return truncate(firstSentence, 140);
  }
  if (lead.website?.heroText) {
    return truncate(lead.website.heroText, 140);
  }
  if (lead.headline) {
    return truncate(lead.headline, 140);
  }
  return `The manual work is eating real hours every week.`;
}

function pickHighlight(headline: string): string {
  // Try to find a noun phrase worth bolding. Cheap heuristic: the longest
  // 2-4 word run that contains a noun-y word. If nothing obvious, use the
  // last 3 words.
  const words = headline.split(/\s+/);
  if (words.length <= 3) return headline;
  const last3 = words.slice(-3).join(" ").replace(/[.!?]$/, "");
  return last3;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}
