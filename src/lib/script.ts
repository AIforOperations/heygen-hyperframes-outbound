import "server-only";
import {
  createMessage,
  extractText,
  type ClaudeModel,
  type MessagesUsage,
} from "./anthropic";
import type { Lead } from "./scrape";

/**
 * Script generation — turns a scraped Lead + a sender + an offer + a tonality
 * choice into a 50–60s spoken script for a HeyGen avatar to deliver.
 *
 * Caching: the system prompt (persona + structural rules + tone block) is
 * stable for repeat calls with the same tonality. We mark it with
 * cache_control so subsequent calls hit the prompt cache instead of re-paying
 * for the full prefix.
 *
 * Output is plain text — no scene markers or labels. HeyGen reads it as-is.
 */

/**
 * Tonality preset IDs match the frontend's VOICE_TEMPLATES exactly. Anything
 * not in this map is treated as a custom tonality string (the user typed
 * their own voice description) and used verbatim.
 */
export type TonalityPreset =
  | "vt_analyst"
  | "vt_founder"
  | "vt_closer"
  | "vt_advisor";

export interface ScriptInput {
  lead: Lead;
  offer: string;
  senderName: string;            // required — the avatar's display name
  senderCompany?: string;        // defaults to "LeadFlow" (product name)
  tonality?: TonalityPreset | string;
  model?: ClaudeModel;
  // Target spoken length in seconds. Word band is derived from this (~2.5
  // words/sec spoken pace). HeyGen render time scales with output duration —
  // pass 30 for fast test runs, 60 for the polished demo. Default: 60.
  lengthSeconds?: number;
}

export interface ScriptResult {
  script: string;
  wordCount: number;
  estimatedSeconds: number;
  model: string;
  usage: MessagesUsage;
}

const DEFAULT_SENDER_COMPANY = "LeadFlow";
const DEFAULT_MODEL: ClaudeModel = "claude-sonnet-4-6";

// ----- Tonality presets -----
//
// Mirrors the frontend's VOICE_TEMPLATES (page.tsx):
//   vt_analyst  — Analyst   — Numbers-first, calm
//   vt_founder  — Founder   — Conversational, warm
//   vt_closer   — Closer    — Direct, urgent
//   vt_advisor  — Advisor   — Helpful, patient

const TONE_PRESETS: Record<TonalityPreset, string> = {
  vt_analyst: `Analyst voice. Numbers-first, calm. Lead the hook with a specific figure from the prospect's reality — years in business, turnaround time, team size, volume — and let the number do the work. Methodical pacing, deliberate sentences. Frame the offer as a measured improvement, not a transformation. Like a senior analyst presenting a finding to a board.`,

  vt_founder: `Founder voice. Conversational, warm, peer-to-peer. Like one founder talking to another. Contractions throughout, natural rhythm, sounds spoken not written. Acknowledge what they've built before pitching anything. The offer is a tool you happen to have, not a silver bullet. Honest energy — no performance.`,

  vt_closer: `Closer voice. Direct, urgent. Short sentences. No preamble — name a specific pain inside the first 12 seconds. Names the cost of doing nothing without being aggressive. Confident, deliberate, slightly leaning forward. Soft urgency around the CTA — make the call feel like the obvious next step.`,

  vt_advisor: `Advisor voice. Helpful, patient. Counselor energy, lower pressure than a sales pitch. Acknowledge they already have competent systems and people. Position the offer as one option among many, framed around their priorities, not yours. Open-ended CTA — invite a conversation, don't push for a yes.`,
};

function toneBlock(tonality: string | undefined): string {
  if (!tonality) return TONE_PRESETS.vt_founder;
  const trimmed = tonality.trim();
  if (trimmed in TONE_PRESETS) {
    return TONE_PRESETS[trimmed as TonalityPreset];
  }
  return trimmed; // custom tonality string, used as-is
}

// ----- Prompt builders -----

function buildSystemPrompt(
  tonality: string | undefined,
  lengthSeconds: number
): string {
  // 2.5 words/sec spoken pace. Band is +/- 10% of target.
  const targetWords = Math.round(lengthSeconds * 2.5);
  const minWords = Math.round(targetWords * 0.9);
  const maxWords = Math.round(targetWords * 1.1);

  return `You write ${lengthSeconds}-second cold outbound video scripts. An avatar will speak these words to a single named prospect, so write spoken English, not written English.

OUTPUT FORMAT
Just the words the avatar says. No labels, no scene markers, no notes.

LENGTH
${minWords}–${maxWords} words (target ${targetWords}). Count words before finalizing. Hitting the band is non-negotiable.

STRUCTURE
1. Open: "Hi [first name], this is [sender] from [sender company]."
2. Hook: One observation about the prospect.
   • If PERSONAL HOOKS are non-empty, reference a specific recent post.
   • Otherwise, hook on what their company does — pull from the website data. Sound like you noticed it, not researched it.
3. Friction: Name one specific friction in their day-to-day that the offer removes. Be concrete (manual data entry, slow client turnarounds, repetitive intake work). One friction, not three.
4. Offer: Reshape the OFFER into a no-brainer (see OFFER RESHAPING below). This is where reply rates are won or lost.
5. Close: One direct line that asks for the yes. "Just say yes and I'll send it over." or "Want me to send it?"

When the target length is short (under 40s), compress the structure — keep the open + offer + close; tighten hook and friction into a single observational sentence.

OFFER RESHAPING (critical — do not skip)
Take the OFFER text from the user as the underlying capability. Then present it as a no-brainer using ONE of these three patterns, in priority order:

(A) Free deliverable, fast turnaround.
    "I'll do [specific deliverable, scoped small] for you completely free, within 48 hours. If you like it, we talk. If not, no obligation."
    Use when the offer is something you can demonstrate on a small scale quickly (a sample, a build, a setup, a fill).

(B) Performance-only.
    "I'll build the whole thing at no cost up front. I only get paid if [specific outcome you can both measure]."
    Use when (A) doesn't fit but the offer has a clear measurable outcome.

(C) Free audit / analysis / report (fallback).
    "I'll put together a short [audit / report / analysis] of [the specific aspect of their business the offer addresses], completely free. Just say yes and I'll send it over within [N] days."
    Use when neither (A) nor (B) fit. Always specific to their situation, never a generic free call.

Rules for the offer:
- One ask, never two.
- Time-bound the delivery (48 hours, this week, 5 days).
- Reduce their input to a single yes ("just say yes and I'll send…"). They should never have to fill out a form or schedule anything before the deliverable.
- Reverse the risk: they pay nothing up front.
- Make the deliverable specific to them, never generic. A "free strategy call" is not a no-brainer. A "free DRE form auto-fill on your next 5 reports" is.

SPOKEN ENGLISH RULES (every sentence must pass these — read it aloud in your head)
- Contractions throughout. "I've", "you're", "we'll", "let's", "that's". No "I would" when "I'd" works.
- Vary sentence length. Mix short and long. Never write three sentences in a row with the same shape or rhythm.
- Don't reference the data you used. No "from what I can tell", "at the volume you're handling", "given your turnaround commitments", "you've seen how…". Just say things directly.
- No flattery. "You've built something impressive" / "great reputation" / "you've done amazing work" are cold-outreach tells. Cut them.
- No hedge transitions. Banned openers: "That said,", "Here's the thing,", "What this means is,", "Given that,", "That's where…", "It's worth noting,".
- No tricolons / rule-of-three lists. Never "X, Y, and Z" structures stacked together (e.g. "pulling project details, filling forms, and chasing accuracy"). One specific thing is more believable than three abstract ones.
- One specific number max per script. Don't pile up stats.
- No em-dashes. Use commas, periods, or just split into two sentences.

BANNED WORDS (cold-outreach AI tells)
seamlessly, leverage, robust, transformative, streamline, elevate, empower, unlock, vibrant, cutting-edge, foster, utilize, comprehensive, harness, paradigm, synergy, optimize, scalable, ecosystem, alignment, holistic, end-to-end, world-class, next-level, game-changer, revolutionize, innovative, deep dive, reimagine, actionable, proactive, impressive, amazing.

OTHER RULES
- Sender introduces themselves once. Don't repeat sender company later.
- Prospect's first name max twice (open + optionally close).
- No emojis.

TONE
${toneBlock(tonality)}`;
}

function buildUserMessage(input: ScriptInput): string {
  const { lead, offer } = input;
  const senderName = input.senderName.trim();
  const senderCompany = input.senderCompany?.trim() || DEFAULT_SENDER_COMPANY;

  const lines: string[] = [];

  lines.push("SENDER");
  lines.push(`- Name: ${senderName}`);
  lines.push(`- Company: ${senderCompany}`);
  lines.push("");

  lines.push("OFFER (what the sender does for the prospect — use this in the script)");
  lines.push(offer.trim());
  lines.push("");

  lines.push("PROSPECT");
  const firstName = lead.firstName || lead.fullName?.split(" ")[0] || "(unknown)";
  lines.push(`- First name: ${firstName}`);
  if (lead.role) lines.push(`- Role: ${lead.role}`);
  if (lead.company.name) lines.push(`- Company: ${lead.company.name}`);
  if (lead.tenureMonths != null) {
    const years = (lead.tenureMonths / 12).toFixed(1);
    lines.push(`- Tenure in current role: ${lead.tenureMonths} months (~${years} years)`);
  }
  if (lead.headline) lines.push(`- LinkedIn headline: ${lead.headline}`);
  lines.push("");

  lines.push("PERSONAL HOOKS (recent posts/activity — may be empty)");
  if (lead.hooks.length === 0) {
    lines.push("(none — use a company-based hook from the WEBSITE block below)");
  } else {
    for (const h of lead.hooks.slice(0, 3)) {
      const snippet = h.text.length > 360 ? h.text.slice(0, 360) + "…" : h.text;
      lines.push(`- [${h.type}${h.postedAt ? `, ${h.postedAt}` : ""}] ${snippet}`);
    }
  }
  lines.push("");

  if (lead.website) {
    lines.push("PROSPECT COMPANY WEBSITE (what they do + how they describe themselves)");
    if (lead.website.heroText) lines.push(`- Hero: ${lead.website.heroText}`);
    if (lead.website.headings.length) {
      lines.push(`- Headings: ${lead.website.headings.slice(0, 12).join(" | ")}`);
    }
    if (lead.website.bodyExcerpt) {
      const body = lead.website.bodyExcerpt.length > 800
        ? lead.website.bodyExcerpt.slice(0, 800) + "…"
        : lead.website.bodyExcerpt;
      lines.push(`- About: ${body}`);
    }
    lines.push("");
  }

  lines.push("Write the 50–60 second spoken script now. Output the spoken text only.");
  return lines.join("\n");
}

// ----- Public API -----

function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

export async function generateScript(input: ScriptInput): Promise<ScriptResult> {
  if (!input.offer || !input.offer.trim()) {
    throw new Error("offer is required");
  }
  if (!input.senderName || !input.senderName.trim()) {
    throw new Error("senderName is required (the avatar's display name)");
  }

  const model = input.model ?? DEFAULT_MODEL;
  const lengthSeconds = input.lengthSeconds ?? 60;
  const system = [
    {
      type: "text" as const,
      text: buildSystemPrompt(input.tonality, lengthSeconds),
      cache_control: { type: "ephemeral" as const },
    },
  ];
  const userMessage = buildUserMessage(input);

  const resp = await createMessage({
    model,
    maxTokens: 600,
    system,
    messages: [{ role: "user", content: userMessage }],
  });

  const script = extractText(resp);
  const wordCount = countWords(script);
  // ~2.5 words/sec is a reasonable spoken-pace estimate (HeyGen avatars
  // typically land in that range with default voice settings).
  const estimatedSeconds = Math.round(wordCount / 2.5);

  return {
    script,
    wordCount,
    estimatedSeconds,
    model: resp.model,
    usage: resp.usage,
  };
}
