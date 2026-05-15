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

// ============================================================================
// ASYNC pipeline — split into two functions so the work survives the
// Vercel 300s function cap.
//
//   1. startPipelineAsync()       (POST /api/generate)
//      Runs scrape + script (sync, ~30s), kicks off HeyGen (returns immediately
//      with a video_id), persists job to Blob. Returns jobId.
//
//   2. progressPipelineAsync()    (GET /api/generate?jobId=…)
//      Reads job. If HeyGen still rendering, polls one tick and returns state.
//      If HeyGen JUST completed, runs transcribe + compose + render inline
//      (~40-50s, fits 300s), persists outputUrl, returns done state.
//
// The frontend polls every 5-10s. The poll that catches HeyGen-completed is
// the one that does the heavy post-work; subsequent polls are no-ops.
// ============================================================================

import {
  createJob,
  readJob,
  updateJob,
  tryClaimProcessing,
  releaseProcessing,
  type JobState,
} from "./jobs";

const ASYNC_DEFAULT_ENGINE: AvatarEngine = "avatar_v";
const ASYNC_DEFAULT_LENGTH_SECONDS = 30;

/**
 * Start the pipeline. Runs scrape + script synchronously, kicks off HeyGen,
 * persists state, returns the job (with jobId for polling).
 *
 * Total time: ~30-60s for scrape + script + HeyGen createVideo. Fits 300s cap.
 */
export async function startPipelineAsync(
  input: OrchestratorInput
): Promise<JobState> {
  const engine = input.engine ?? ASYNC_DEFAULT_ENGINE;
  const lengthSeconds = input.lengthSeconds ?? ASYNC_DEFAULT_LENGTH_SECONDS;
  const job = await createJob({ ...input, engine, lengthSeconds });

  try {
    // Stage 1: scrape
    let t = Date.now();
    const scrape = await scrapeLead(input.input);
    await updateJob(job.jobId, {
      stage: "script",
      lead: scrape.lead,
      stages: { scrape: { ms: Date.now() - t } },
    });

    // Stage 2: script
    t = Date.now();
    const scriptResult = await generateScript({
      lead: scrape.lead,
      offer: input.offer,
      senderName: input.senderName,
      senderCompany: input.senderCompany,
      tonality: input.tonality,
      model: input.scriptModel,
      lengthSeconds,
    });
    await updateJob(job.jobId, {
      stage: "heygen",
      scriptText: scriptResult.script,
      wordCount: scriptResult.wordCount,
      estimatedSeconds: scriptResult.estimatedSeconds,
      stages: { script: { ms: Date.now() - t } },
    });

    // Stage 3 (kickoff only): HeyGen createVideo
    t = Date.now();
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
      title: `LeadFlow pipeline ${job.jobId}`,
    });
    return await updateJob(job.jobId, {
      stage: "heygen",
      heygenVideoId: created.video_id,
      heygenStatus: created.status,
      stages: { heygenKickoff: { ms: Date.now() - t } },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return await updateJob(job.jobId, {
      stage: "error",
      status: "failed",
      error: message,
    });
  }
}

/**
 * Advance the pipeline one tick. Frontend calls this on every poll.
 *
 * Behavior by stage:
 *   - heygen      → check HeyGen status; if completed, run post-render stages
 *   - done/error  → return state, no-op
 *   - earlier     → return state (start should have advanced past these)
 *
 * Race protection: tries to claim a `processing` lock. If another caller is
 * already advancing, returns the current state immediately.
 */
export async function progressPipelineAsync(jobId: string): Promise<JobState | null> {
  const initial = await readJob(jobId);
  if (!initial) return null;
  if (initial.status === "complete" || initial.status === "failed") return initial;

  // Race guard for concurrent polls from the same user.
  const claimed = await tryClaimProcessing(jobId);
  if (!claimed) return initial; // already advancing in another caller

  try {
    return await advanceStage(claimed);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return await updateJob(jobId, {
      stage: "error",
      status: "failed",
      processing: false,
      error: message,
    });
  } finally {
    // Best-effort release in case advanceStage didn't update processing
    await releaseProcessing(jobId).catch(() => {});
  }
}

async function advanceStage(job: JobState): Promise<JobState> {
  if (job.stage !== "heygen") {
    // Earlier stages should have been handled in startPipelineAsync; if we
    // see one here it likely means startPipelineAsync errored — just return.
    return job;
  }
  if (!job.heygenVideoId) {
    throw new Error("Job in heygen stage but heygenVideoId missing");
  }

  // Poll HeyGen once.
  const v = await getVideo(job.heygenVideoId);
  if (v.status === "failed") {
    return await updateJob(job.jobId, {
      stage: "error",
      status: "failed",
      heygenStatus: v.status,
      error: `HeyGen render failed: ${v.failure_message ?? v.failure_code ?? "unknown"}`,
    });
  }
  if (v.status !== "completed") {
    // Still rendering — just update heartbeat fields and return.
    return await updateJob(job.jobId, { heygenStatus: v.status });
  }

  // HeyGen done. Run the rest of the pipeline inline.
  if (!v.video_url || !v.duration) {
    throw new Error("HeyGen completed but missing video_url or duration");
  }

  await updateJob(job.jobId, {
    stage: "transcribe",
    heygenVideoUrl: v.video_url,
    heygenDuration: v.duration,
    heygenStatus: v.status,
  });

  // Transcribe
  let t = Date.now();
  const audio = await extractAudioFromVideoUrl(v.video_url);
  const audioBlob = new Blob([Uint8Array.from(audio.buffer)], { type: audio.contentType });
  const transcription = await transcribeAudio({
    audio: audioBlob,
    filename: audio.filename,
    contentType: audio.contentType,
    timestampsGranularity: "word",
  });
  await updateJob(job.jobId, {
    stage: "compose",
    transcript: transcription.text,
    wordTimestamps: transcription.words,
    stages: { transcribe: { ms: Date.now() - t } },
  });

  // Compose
  t = Date.now();
  const mp4Resp = await fetch(v.video_url);
  if (!mp4Resp.ok) throw new Error(`Failed to download HeyGen MP4: ${mp4Resp.status}`);
  const mp4 = Buffer.from(await mp4Resp.arrayBuffer());
  const files = buildCompositionFiles({
    mp4,
    duration: v.duration,
    avatarId: job.input.avatarId,
  });
  await updateJob(job.jobId, {
    stage: "render",
    stages: { compose: { ms: Date.now() - t } },
  });

  // Render + upload
  t = Date.now();
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

  // Done
  const final = await updateJob(job.jobId, {
    stage: "done",
    status: "complete",
    completedAt: new Date().toISOString(),
    processing: false,
    outputUrl: blob.url,
    stages: { render: { ms: Date.now() - t } },
  });
  return final;
}
