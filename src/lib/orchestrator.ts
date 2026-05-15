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
import { buildCompositionV2 } from "./composition-v2";
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
// ASYNC pipeline — split per-stage so the frontend sees each stage advance
// individually as it polls.
//
//   POST /api/generate
//     → startPipelineAsync(): create job at stage="scrape", return immediately.
//       The HTTP response is fast (~200ms).
//
//   GET /api/generate?jobId=X    (frontend polls every ~3s)
//     → progressPipelineAsync(): claims a lock, runs the ONE stage matching
//       the current job.stage, writes the updated state, returns it. Each
//       poll advances by exactly one logical stage.
//
//   Stage progression:
//     scrape → script → heygen-create → heygen-poll (×N) → transcribe → done
//   The transcribe tick bundles transcribe + compose + render (~50s, fits
//   the 300s function cap).
//
// Concurrency: a `processing: true` flag on the job acts as a lock. If two
// concurrent GETs from the same user race, the second one returns the
// current state without re-running the stage.
//
// Why per-stage (and not multi-write in one call): Vercel Blob's CDN had
// us reading stale state inside a single function when we wrote multiple
// times in quick succession, clobbering earlier writes. With one write per
// invocation we always see the freshest state when the next poll arrives.
// ============================================================================

import {
  createJob,
  readJob,
  writeJob,
  tryClaimProcessing,
  releaseProcessing,
  type JobState,
} from "./jobs";

const ASYNC_DEFAULT_ENGINE: AvatarEngine = "avatar_v";
const ASYNC_DEFAULT_LENGTH_SECONDS = 30;

/**
 * Create a job at stage="scrape" and return immediately. The actual work
 * happens on subsequent GET polls.
 */
export async function startPipelineAsync(
  input: OrchestratorInput
): Promise<JobState> {
  const engine = input.engine ?? ASYNC_DEFAULT_ENGINE;
  const lengthSeconds = input.lengthSeconds ?? ASYNC_DEFAULT_LENGTH_SECONDS;
  return await createJob({ ...input, engine, lengthSeconds });
}

/**
 * Advance the pipeline by one stage. Called from GET /api/generate.
 *
 * The lock is acquired before dispatching to a stage handler; on completion
 * (or error) it's released. Per-stage handlers do their work in memory and
 * `writeJob` exactly once with the new full state.
 */
export async function progressPipelineAsync(jobId: string): Promise<JobState | null> {
  const initial = await readJob(jobId);
  if (!initial) return null;
  if (initial.status === "complete" || initial.status === "failed") return initial;

  const claimed = await tryClaimProcessing(jobId);
  if (!claimed) return initial;

  try {
    // Re-read after acquiring the lock so we dispatch on the latest state,
    // not the snapshot from before the lock. Blob CDN is eventually
    // consistent — without this, two close polls can both see the
    // pre-videoId state and both fire HeyGen createVideo.
    const fresh = (await readJob(jobId)) ?? claimed;
    if (fresh.status === "complete" || fresh.status === "failed") return fresh;
    return await advanceStage(fresh);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    const errored: JobState = {
      ...claimed,
      stage: "error",
      status: "failed",
      processing: false,
      error: message,
    };
    return await writeJob(errored);
  } finally {
    await releaseProcessing(jobId).catch(() => {});
  }
}

async function advanceStage(job: JobState): Promise<JobState> {
  switch (job.stage) {
    case "scrape":
      return await stageScrape(job);
    case "script":
      return await stageScript(job);
    case "heygen":
      return job.heygenVideoId
        ? await stageHeygenPoll(job)
        : await stageHeygenCreate(job);
    case "transcribe":
    case "compose":
    case "render":
      return await stagePostHeygen(job);
    case "done":
    case "error":
      return job;
    default:
      return job;
  }
}

async function stageScrape(job: JobState): Promise<JobState> {
  const t = Date.now();
  const scrape = await scrapeLead(job.input.input);
  return await writeJob({
    ...job,
    stage: "script",
    lead: scrape.lead,
    processing: false,
    stages: { ...job.stages, scrape: { ms: Date.now() - t } },
  });
}

async function stageScript(job: JobState): Promise<JobState> {
  if (!job.lead) throw new Error("lead missing for script stage");
  const t = Date.now();
  const scriptResult = await generateScript({
    lead: job.lead,
    offer: job.input.offer,
    senderName: job.input.senderName,
    senderCompany: job.input.senderCompany,
    tonality: job.input.tonality,
    model: job.input.scriptModel,
    lengthSeconds: job.input.lengthSeconds,
  });
  return await writeJob({
    ...job,
    stage: "heygen",
    scriptText: scriptResult.script,
    wordCount: scriptResult.wordCount,
    estimatedSeconds: scriptResult.estimatedSeconds,
    processing: false,
    stages: { ...job.stages, script: { ms: Date.now() - t } },
  });
}

async function stageHeygenCreate(job: JobState): Promise<JobState> {
  // Final guardrail: re-read state immediately before kicking off a HeyGen
  // render. Blob CDN can serve stale snapshots for several seconds even with
  // cache-busting, and two concurrent polls dispatched on the same pre-video
  // snapshot can both end up here. If videoId already exists, bail out and
  // let the next poll handle the polling stage.
  const latest = await readJob(job.jobId);
  if (latest?.heygenVideoId) {
    return await writeJob({ ...latest, processing: false });
  }

  if (!job.scriptText) throw new Error("scriptText missing for heygen-create");
  const t = Date.now();
  const engine = job.input.engine ?? ASYNC_DEFAULT_ENGINE;
  const look = await getAvatarLook(job.input.avatarId);
  const supported = look.supported_api_engines ?? [];
  if (!supported.includes(engine)) {
    throw new Error(
      `Avatar "${look.name}" does not support engine "${engine}". ` +
        `Supported: ${supported.join(", ") || "(none)"}`
    );
  }
  const preferredVoiceId = job.input.voiceId ?? look.default_voice_id ?? FALLBACK_VOICE_ID;

  // Some avatars (e.g. Leos) have a default_voice_id that HeyGen no longer
  // honors — they return "Voice not found" at create-time. Retry once with
  // the known-good fallback voice rather than failing the whole pipeline.
  async function tryCreate(voiceId: string) {
    return createVideo({
      avatarId: job.input.avatarId,
      script: job.scriptText!,
      voiceId,
      engine,
      resolution: "1080p",
      aspectRatio: "16:9",
      title: `LeadFlow pipeline ${job.jobId}`,
      // HeyGen idempotency: same jobId + same payload returns the same video
      // instead of creating a new one. This is the only layer that bills $0
      // for duplicates — the in-handler re-read and lock above are best-effort.
      callbackId: job.jobId,
    });
  }
  let created;
  let voiceId = preferredVoiceId;
  try {
    created = await tryCreate(preferredVoiceId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    const looksLikeBadVoice =
      err instanceof HeyGenError && /voice_id|voice not found/i.test(msg);
    if (looksLikeBadVoice && preferredVoiceId !== FALLBACK_VOICE_ID) {
      console.warn(
        `[orchestrator] HeyGen rejected voice ${preferredVoiceId} for avatar ${job.input.avatarId}, retrying with FALLBACK_VOICE_ID`
      );
      voiceId = FALLBACK_VOICE_ID;
      created = await tryCreate(FALLBACK_VOICE_ID);
    } else {
      throw err;
    }
  }
  void voiceId; // bookkeeping; final voiceId not stored on the job today
  return await writeJob({
    ...job,
    heygenVideoId: created.video_id,
    heygenStatus: created.status,
    processing: false,
    stages: { ...job.stages, heygenCreate: { ms: Date.now() - t } },
  });
}

async function stageHeygenPoll(job: JobState): Promise<JobState> {
  if (!job.heygenVideoId) throw new Error("heygenVideoId missing");
  const v = await getVideo(job.heygenVideoId);
  if (v.status === "failed") {
    return await writeJob({
      ...job,
      stage: "error",
      status: "failed",
      heygenStatus: v.status,
      processing: false,
      error: `HeyGen render failed: ${v.failure_message ?? v.failure_code ?? "unknown"}`,
    });
  }
  if (v.status !== "completed") {
    return await writeJob({
      ...job,
      heygenStatus: v.status,
      processing: false,
    });
  }
  // HeyGen done — advance to transcribe stage; post-work runs on next poll.
  if (!v.video_url || !v.duration) {
    throw new Error("HeyGen completed but missing video_url or duration");
  }
  return await writeJob({
    ...job,
    stage: "transcribe",
    heygenVideoUrl: v.video_url,
    heygenDuration: v.duration,
    heygenStatus: v.status,
    processing: false,
  });
}

/**
 * Post-HeyGen bundle: transcribe + compose + render + upload. ~50s total.
 * Fits within one 300s function call. We accept that the UI only sees one
 * transition here ("transcribe"/"compose"/"render" → "done") because
 * splitting them would add 3 extra poll round-trips for ~50s of work.
 */
async function stagePostHeygen(job: JobState): Promise<JobState> {
  if (!job.heygenVideoUrl || !job.heygenDuration) {
    throw new Error("heygen video URL/duration missing for post-heygen stage");
  }

  let working: JobState = { ...job };

  // Transcribe
  let t = Date.now();
  const audio = await extractAudioFromVideoUrl(job.heygenVideoUrl);
  const mp4 = audio.buffer;
  const audioBlob = new Blob([Uint8Array.from(audio.buffer)], { type: audio.contentType });
  const transcription = await transcribeAudio({
    audio: audioBlob,
    filename: audio.filename,
    contentType: audio.contentType,
    timestampsGranularity: "word",
  });
  working = {
    ...working,
    stage: "compose",
    transcript: transcription.text,
    wordTimestamps: transcription.words,
    stages: { ...working.stages, transcribe: { ms: Date.now() - t } },
  };

  // Compose — scene-based v2 builder. Falls back to lead defaults if any
  // scrape field is missing.
  t = Date.now();
  if (!job.lead) throw new Error("lead missing for compose stage");
  const files = await buildCompositionV2({
    jobId: job.jobId,
    mp4,
    duration: job.heygenDuration,
    avatarId: job.input.avatarId,
    lead: job.lead,
    senderName: job.input.senderName,
    senderCompany: job.input.senderCompany || "LeadFlow",
    scriptText: job.scriptText,
    offer: job.input.offer,
  });
  working = {
    ...working,
    stage: "render",
    stages: { ...working.stages, compose: { ms: Date.now() - t } },
  };

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

  return await writeJob({
    ...working,
    stage: "done",
    status: "complete",
    completedAt: new Date().toISOString(),
    processing: false,
    outputUrl: blob.url,
    stages: { ...working.stages, render: { ms: Date.now() - t } },
  });
}
