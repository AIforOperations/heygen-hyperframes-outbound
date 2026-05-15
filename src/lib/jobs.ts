import "server-only";
import { head, list, put } from "@vercel/blob";
import type { Lead } from "./scrape";
import type { ElevenLabsWord } from "./elevenlabs";
import type { OrchestratorInput } from "./orchestrator";

/**
 * Vercel Blob-backed job state for the async pipeline.
 *
 * Why Blob instead of KV: Blob is already provisioned for video uploads.
 * Adding KV/Upstash means another integration step. For a hackathon with one
 * concurrent user, Blob's read latency (~150ms) is fine. Switch to KV if we
 * see traffic.
 *
 * Layout in Blob:
 *   jobs/<jobId>.json   — full JobState, public read, overwritable
 *
 * Job IDs are URL-safe random strings; we trust them as the only handle the
 * frontend needs to track its own pipeline run.
 */

export type JobStage =
  | "scrape"
  | "script"
  | "heygen"
  | "transcribe"
  | "compose"
  | "render"
  | "done"
  | "error";

export type JobStatus = "running" | "complete" | "failed";

export interface JobState {
  jobId: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;

  stage: JobStage;
  status: JobStatus;
  processing: boolean;  // race-guard for concurrent GET callers

  // Snapshot of the inputs — needed because the async webhook/status
  // continuation runs in a different function invocation with no closure
  // over the original request body.
  input: OrchestratorInput;

  // Accumulating outputs
  lead?: Lead;
  scriptText?: string;
  wordCount?: number;
  estimatedSeconds?: number;

  heygenVideoId?: string;
  heygenVideoUrl?: string;
  heygenDuration?: number;
  heygenStatus?: string;

  transcript?: string;
  wordTimestamps?: ElevenLabsWord[];

  outputUrl?: string;       // final composited HyperFrames video

  error?: string;

  stages: Record<string, { ms: number }>;
}

function jobKey(jobId: string): string {
  return `jobs/${jobId}.json`;
}

function randomJobId(): string {
  // 16 url-safe chars. Enough entropy for hackathon usage.
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function createJob(input: OrchestratorInput): Promise<JobState> {
  const now = new Date().toISOString();
  const job: JobState = {
    jobId: randomJobId(),
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    stage: "scrape",
    status: "running",
    processing: false,
    input,
    stages: {},
  };
  await persist(job);
  return job;
}

export async function readJob(jobId: string): Promise<JobState | null> {
  try {
    // Blob lookup by exact pathname is via head().
    const meta = await head(jobKey(jobId));
    // Cache-bust: Vercel Blob URLs go through a CDN with a 30-day default
    // Cache-Control. Multiple sequential updateJob() calls inside a single
    // function would otherwise read stale state and clobber prior writes.
    const url = `${meta.url}${meta.url.includes("?") ? "&" : "?"}_t=${Date.now()}`;
    const resp = await fetch(url, { cache: "no-store" });
    if (!resp.ok) return null;
    return (await resp.json()) as JobState;
  } catch {
    return null;
  }
}

export async function updateJob(
  jobId: string,
  patch: Partial<JobState>
): Promise<JobState> {
  const current = await readJob(jobId);
  if (!current) throw new Error(`Job ${jobId} not found`);
  const next: JobState = {
    ...current,
    ...patch,
    jobId: current.jobId,                              // never overwrite
    createdAt: current.createdAt,                      // never overwrite
    updatedAt: new Date().toISOString(),
    stages: { ...current.stages, ...(patch.stages ?? {}) },
  };
  await persist(next);
  return next;
}

/**
 * Direct write — caller holds the authoritative state in memory, no re-read.
 *
 * Use this from the orchestrator. It sidesteps Blob's CDN cache problem:
 * sequential read-modify-write would re-read a stale snapshot and clobber
 * unflushed fields. With writeJob the caller mutates a local object and
 * pushes the full state in one shot.
 */
export async function writeJob(job: JobState): Promise<JobState> {
  const next: JobState = { ...job, updatedAt: new Date().toISOString() };
  await persist(next);
  return next;
}

/** Try to claim the processing lock. Returns true if claimed, false if
 * another caller is already advancing this job. */
export async function tryClaimProcessing(jobId: string): Promise<JobState | null> {
  const current = await readJob(jobId);
  if (!current) return null;
  if (current.processing) return null;
  return updateJob(jobId, { processing: true });
}

export async function releaseProcessing(jobId: string): Promise<void> {
  await updateJob(jobId, { processing: false });
}

/**
 * List recent completed jobs (newest first). Used by /api/gallery.
 * Bounded by `limit` to keep response payload small.
 */
export async function listCompletedJobs(limit = 20): Promise<JobState[] | null> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const r = await list({ prefix: "jobs/", limit: 100 });
    // Sort newest first by uploadedAt (Blob's mtime).
    const blobs = r.blobs.sort(
      (a, b) => +new Date(b.uploadedAt) - +new Date(a.uploadedAt)
    );
    const out: JobState[] = [];
    for (const b of blobs) {
      if (out.length >= limit) break;
      try {
        const resp = await fetch(b.url);
        if (!resp.ok) continue;
        const job = (await resp.json()) as JobState;
        if (job.status === "complete" && job.outputUrl) {
          out.push(job);
        }
      } catch {
        // skip unreadable
      }
    }
    return out;
  } catch {
    return null;
  }
}

async function persist(job: JobState): Promise<void> {
  await put(jobKey(job.jobId), JSON.stringify(job), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
    // 1s max-age. Job state changes every few seconds during a pipeline run;
    // we must not let the CDN serve a stale snapshot to subsequent
    // readJob() callers in the same function chain.
    cacheControlMaxAge: 1,
  });
}
