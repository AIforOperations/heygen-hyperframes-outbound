import "server-only";
import { put } from "@vercel/blob";
import { scrapeLead, type Lead } from "./scrape";
import { generateScript } from "./script";
import {
  createVideo,
  getAvatarLook,
  getVideo,
  HeyGenError,
  type AvatarEngine,
} from "./heygen";
import { extractAudioFromVideoUrl } from "./audio";
import { transcribeAudio, type ElevenLabsWord } from "./elevenlabs";
import { buildCompositionFiles } from "./composition";
import { renderInSandbox } from "./sandbox";
import type { ScrapeInput } from "./resolve";
import type { ClaudeModel } from "./anthropic";

/**
 * End-to-end pipeline orchestrator.
 *
 * Stages (sequential — each blocks the next):
 *   1. scrape       → Lead
 *   2. script       → spoken text
 *   3. heygen       → MP4 url + duration (Avatar IV by default for time budget;
 *                     Avatar V available but consumes ~+60s)
 *   4. transcribe   → word_timestamps (ElevenLabs Scribe v1)
 *   5. compose      → SandboxFile[] (in-memory, no disk I/O)
 *   6. render       → final composited MP4 → Vercel Blob URL
 *
 * The full pipeline must fit in the 300s Vercel Hobby function cap. Avatar IV
 * typical: ~110–180s. Avatar V typical: ~140–240s — tight.
 *
 * Progress reporting: pass an `onProgress` callback to receive `ProgressEvent`s
 * as each stage starts/completes. The API route wraps this for SSE streaming.
 */

export interface OrchestratorInput {
  // Scrape
  input: ScrapeInput;

  // Script
  offer: string;
  senderName: string;             // avatar's display name (required)
  senderCompany?: string;         // default "LeadFlow"
  tonality?: string;
  scriptModel?: ClaudeModel;
  lengthSeconds?: number;         // default 60. Pass 30 for fast test renders.

  // HeyGen
  avatarId: string;
  engine?: AvatarEngine;          // default "avatar_iv" (faster, fits budget)
  voiceId?: string;               // default = avatar's HeyGen default voice

  // Polling
  pollIntervalMs?: number;        // default 10s
  // HeyGen render time scales with output duration. Empirical: a 60s avatar
  // video takes 5–8 minutes on Avatar IV, 8–14 minutes on Avatar V. That's
  // way past the Vercel Hobby 300s function cap, so production needs the
  // webhook pattern (POST → return jobId → HeyGen callback finishes the work).
  // For local dev (`next dev` ignores maxDuration), we wait up to 10 minutes.
  pollTimeoutMs?: number;         // default 600s (local dev)
}

export interface ProgressEvent {
  stage:
    | "scrape"
    | "script"
    | "heygen"
    | "transcribe"
    | "compose"
    | "render"
    | "done"
    | "error";
  status: "started" | "progress" | "complete" | "failed";
  ms?: number;
  data?: unknown;
  message?: string;
}

export interface OrchestratorResult {
  ok: true;
  outputUrl: string;          // final composited video
  rawAvatarUrl: string;       // raw HeyGen render (before composition)
  duration: number;           // seconds
  lead: Lead;
  script: string;
  wordCount: number;
  transcript: string;
  wordTimestamps: ElevenLabsWord[];
  stages: Record<string, { ms: number }>;
  totalMs: number;
}

export type OnProgress = (event: ProgressEvent) => void | Promise<void>;

const FALLBACK_VOICE_ID = "007e1378fc454a9f976db570ba6164a7"; // Aria

export async function runPipeline(
  input: OrchestratorInput,
  onProgress?: OnProgress
): Promise<OrchestratorResult> {
  const startedAt = Date.now();
  const stages: Record<string, { ms: number }> = {};
  const engine: AvatarEngine = input.engine ?? "avatar_iv";
  const pollIntervalMs = input.pollIntervalMs ?? 10_000;
  const pollTimeoutMs = input.pollTimeoutMs ?? 600_000;

  const emit = async (event: ProgressEvent) => {
    if (onProgress) await onProgress(event);
  };

  // ---------- Stage 1: scrape ----------
  await emit({ stage: "scrape", status: "started" });
  const tScrape = Date.now();
  const scrapeResult = await scrapeLead(input.input);
  stages.scrape = { ms: Date.now() - tScrape };
  await emit({
    stage: "scrape",
    status: "complete",
    ms: stages.scrape.ms,
    data: {
      person: scrapeResult.lead.firstName ?? scrapeResult.lead.fullName,
      company: scrapeResult.lead.company.name,
      hooks: scrapeResult.lead.hooks.length,
      hasWebsite: scrapeResult.lead.website !== null,
    },
  });

  // ---------- Stage 2: script ----------
  await emit({ stage: "script", status: "started" });
  const tScript = Date.now();
  const scriptResult = await generateScript({
    lead: scrapeResult.lead,
    offer: input.offer,
    senderName: input.senderName,
    senderCompany: input.senderCompany,
    tonality: input.tonality,
    model: input.scriptModel,
    lengthSeconds: input.lengthSeconds,
  });
  stages.script = { ms: Date.now() - tScript };
  await emit({
    stage: "script",
    status: "complete",
    ms: stages.script.ms,
    data: {
      wordCount: scriptResult.wordCount,
      estimatedSeconds: scriptResult.estimatedSeconds,
      model: scriptResult.model,
      preview: scriptResult.script.slice(0, 200),
    },
  });

  // ---------- Stage 3: heygen ----------
  await emit({ stage: "heygen", status: "started" });
  const tHeygen = Date.now();

  // Validate avatar supports the engine before kicking off a render.
  const look = await getAvatarLook(input.avatarId);
  const supported = look.supported_api_engines ?? [];
  if (!supported.includes(engine)) {
    throw new Error(
      `Avatar "${look.name}" does not support engine "${engine}". ` +
        `Supported: ${supported.join(", ") || "(none)"}`
    );
  }
  const voiceId = input.voiceId ?? look.default_voice_id ?? FALLBACK_VOICE_ID;

  const created = await createVideo({
    avatarId: input.avatarId,
    script: scriptResult.script,
    voiceId,
    engine,
    resolution: "1080p",
    aspectRatio: "16:9",
    title: `Pipeline render @ ${new Date().toISOString()}`,
  });

  // Poll. HeyGen has no streaming progress, so we emit a heartbeat each tick.
  const deadline = Date.now() + pollTimeoutMs;
  let final = null;
  let lastStatus = created.status;
  while (Date.now() < deadline) {
    const v = await getVideo(created.video_id);
    lastStatus = v.status;
    await emit({
      stage: "heygen",
      status: "progress",
      ms: Date.now() - tHeygen,
      data: { videoId: created.video_id, status: v.status },
    });
    if (v.status === "completed" || v.status === "failed") {
      final = v;
      break;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  if (!final) {
    throw new Error(
      `HeyGen render did not finish within ${pollTimeoutMs}ms (last: ${lastStatus})`
    );
  }
  if (final.status === "failed") {
    throw new HeyGenError(
      502,
      null,
      `HeyGen render failed: ${final.failure_message ?? final.failure_code ?? "unknown"}`
    );
  }
  if (!final.video_url || !final.duration) {
    throw new Error("HeyGen render completed but missing video_url or duration");
  }

  stages.heygen = { ms: Date.now() - tHeygen };
  await emit({
    stage: "heygen",
    status: "complete",
    ms: stages.heygen.ms,
    data: {
      videoId: created.video_id,
      videoUrl: final.video_url,
      duration: final.duration,
      engine,
    },
  });

  // ---------- Stage 4: transcribe ----------
  // Audio extract + Scribe in one stage — both are quick.
  await emit({ stage: "transcribe", status: "started" });
  const tTrans = Date.now();
  const audio = await extractAudioFromVideoUrl(final.video_url);
  const audioBlob = new Blob([Uint8Array.from(audio.buffer)], {
    type: audio.contentType,
  });
  const transcription = await transcribeAudio({
    audio: audioBlob,
    filename: audio.filename,
    contentType: audio.contentType,
    timestampsGranularity: "word",
  });
  stages.transcribe = { ms: Date.now() - tTrans };
  await emit({
    stage: "transcribe",
    status: "complete",
    ms: stages.transcribe.ms,
    data: {
      wordCount: transcription.words.filter((w) => w.type === "word").length,
      languageCode: transcription.language_code,
    },
  });

  // ---------- Stage 5: compose ----------
  // We need the MP4 buffer for the composition. extractAudioFromVideoUrl
  // downloads it already but throws it away after pulling audio; cheapest
  // option is to re-download here (HeyGen URLs are cached, ~1s).
  await emit({ stage: "compose", status: "started" });
  const tComp = Date.now();
  const mp4Resp = await fetch(final.video_url);
  if (!mp4Resp.ok) {
    throw new Error(`Failed to download HeyGen MP4: ${mp4Resp.status}`);
  }
  const mp4 = Buffer.from(await mp4Resp.arrayBuffer());
  const files = buildCompositionFiles({
    mp4,
    duration: final.duration,
    avatarId: input.avatarId,
  });
  stages.compose = { ms: Date.now() - tComp };
  await emit({
    stage: "compose",
    status: "complete",
    ms: stages.compose.ms,
    data: { fileCount: files.length, mp4Bytes: mp4.byteLength },
  });

  // ---------- Stage 6: render + upload ----------
  await emit({ stage: "render", status: "started" });
  const tRender = Date.now();
  const renderResult = await renderInSandbox(files);
  const blob = await put(
    `renders/${new Date().toISOString().replace(/[:.]/g, "-")}.mp4`,
    renderResult.mp4,
    {
      access: "public",
      contentType: "video/mp4",
      addRandomSuffix: true,
      allowOverwrite: false,
    }
  );
  stages.render = { ms: Date.now() - tRender };
  await emit({
    stage: "render",
    status: "complete",
    ms: stages.render.ms,
    data: {
      url: blob.url,
      bytes: renderResult.mp4.byteLength,
      fromSnapshot: renderResult.fromSnapshot,
    },
  });

  const result: OrchestratorResult = {
    ok: true,
    outputUrl: blob.url,
    rawAvatarUrl: final.video_url,
    duration: final.duration,
    lead: scrapeResult.lead,
    script: scriptResult.script,
    wordCount: scriptResult.wordCount,
    transcript: transcription.text,
    wordTimestamps: transcription.words,
    stages,
    totalMs: Date.now() - startedAt,
  };
  await emit({ stage: "done", status: "complete", ms: result.totalMs, data: { outputUrl: result.outputUrl } });
  return result;
}
