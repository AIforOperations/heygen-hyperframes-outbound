import "server-only";
import { Redis } from "@upstash/redis";
import type { Lead } from "./scrape";
import type { ElevenLabsWord } from "./elevenlabs";
import type { OrchestratorInput } from "./orchestrator";

/**
 * Upstash Redis-backed job state for the async pipeline.
 *
 * Why Redis (not Blob): Blob's underlying object storage is eventually
 * consistent for overwrites. The previous Blob-based implementation hit a
 * persistent read-after-write race where /api/generate?jobId polls would
 * see stale state across stage transitions, causing stage handlers to
 * re-dispatch onto stale snapshots and pin jobs at stage="heygen" /
 * heygenStatus="waiting" even after HeyGen had completed the render.
 *
 * Redis is strongly consistent for reads after writes — and gives us a
 * proper atomic lock via SET NX EX instead of the previous in-state
 * `processing` flag (which itself raced).
 *
 * Layout in Redis:
 *   lf:job:<jobId>          → JSON JobState (TTL 7d)
 *   lf:lock:<jobId>         → "1" with TTL 120s for stage-handler mutex
 *   lf:completed            → ZSET (score=completion timestamp, member=jobId)
 *                             — newest-first index used by /api/gallery
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
  // Vestigial — kept so orchestrator code that sets `processing: false` at the
  // end of every stage handler still type-checks. The real lock is in Redis at
  // lf:lock:<jobId>. Don't make new code branch on this field.
  processing: boolean;

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

  outputUrl?: string;

  error?: string;

  stages: Record<string, { ms: number }>;
}

// ---------- Redis client ----------

const JOB_KEY_PREFIX = "lf:job:";
const LOCK_KEY_PREFIX = "lf:lock:";
const COMPLETED_INDEX = "lf:completed";
const JOB_TTL_S = 7 * 24 * 60 * 60;   // 7 days
const LOCK_TTL_S = 120;                // covers HeyGen-poll worst case per tick

let _redis: Redis | null = null;
function redis(): Redis {
  if (_redis) return _redis;
  // The Vercel Marketplace Upstash integration provisions env vars with the
  // KV_REST_API_* prefix (legacy compat with the deprecated @vercel/kv
  // package), NOT the UPSTASH_REDIS_REST_* prefix that Redis.fromEnv()
  // expects. Construct explicitly. Fall back to UPSTASH_* for setups that
  // wired Upstash directly (without going through the Vercel Marketplace).
  const url =
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error(
      "Upstash Redis env vars missing: set KV_REST_API_URL + KV_REST_API_TOKEN " +
        "(or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN). The Vercel " +
        "Marketplace Upstash integration auto-provisions the KV_* pair."
    );
  }
  _redis = new Redis({ url, token });
  return _redis;
}

function jobKey(jobId: string): string {
  return `${JOB_KEY_PREFIX}${jobId}`;
}

function lockKey(jobId: string): string {
  return `${LOCK_KEY_PREFIX}${jobId}`;
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

// ---------- Public API (signatures unchanged from the Blob impl) ----------

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
  await redis().set(jobKey(job.jobId), JSON.stringify(job), { ex: JOB_TTL_S });
  return job;
}

export async function readJob(jobId: string): Promise<JobState | null> {
  // Upstash auto-parses JSON when the stored value is JSON-serializable. If
  // someone wrote a plain string it stays a string — coerce defensively.
  const raw = await redis().get<JobState | string | null>(jobKey(jobId));
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as JobState;
    } catch {
      return null;
    }
  }
  return raw;
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
    jobId: current.jobId,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
    stages: { ...current.stages, ...(patch.stages ?? {}) },
  };
  await persist(next, current);
  return next;
}

/**
 * Direct write — caller holds the authoritative state in memory, no re-read.
 * With Redis this is safe even for back-to-back writes because reads are
 * strongly consistent. Use from per-stage handlers in orchestrator.ts.
 */
export async function writeJob(job: JobState): Promise<JobState> {
  const previous = await redis().get<JobState | string | null>(jobKey(job.jobId));
  const previousState: JobState | null =
    previous == null
      ? null
      : typeof previous === "string"
        ? (JSON.parse(previous) as JobState)
        : previous;
  const next: JobState = { ...job, updatedAt: new Date().toISOString() };
  await persist(next, previousState);
  return next;
}

/**
 * Acquire the per-job stage-handler lock via atomic SET NX EX. Returns the
 * current job state when claimed; null when another caller already holds it.
 *
 * Auto-expires after LOCK_TTL_S so a function killed by the Vercel function
 * timeout doesn't deadlock the pipeline — the next poll force-claims via the
 * NX semantics once Redis evicts the key.
 */
export async function tryClaimProcessing(jobId: string): Promise<JobState | null> {
  const acquired = await redis().set(lockKey(jobId), "1", {
    nx: true,
    ex: LOCK_TTL_S,
  });
  if (!acquired) return null;
  const job = await readJob(jobId);
  if (!job) {
    // Lock with no job — release and bail. Shouldn't happen unless the job
    // TTL expired between createJob and the first poll.
    await releaseProcessing(jobId);
    return null;
  }
  return job;
}

export async function releaseProcessing(jobId: string): Promise<void> {
  await redis().del(lockKey(jobId));
}

/**
 * Newest-first list of completed jobs, bounded by `limit`. Used by
 * /api/gallery. Backed by a ZSET that's appended to in persist() when a job
 * first transitions into status="complete" — much cheaper than scanning all
 * job keys.
 */
export async function listCompletedJobs(limit = 20): Promise<JobState[] | null> {
  try {
    const ids = (await redis().zrange<string[]>(
      COMPLETED_INDEX,
      0,
      Math.max(0, limit - 1),
      { rev: true }
    )) ?? [];
    if (!ids.length) return [];
    const states = await Promise.all(ids.map((id) => readJob(id)));
    return states.filter(
      (s): s is JobState =>
        s !== null && s.status === "complete" && !!s.outputUrl
    );
  } catch {
    return null;
  }
}

// ---------- Internals ----------

async function persist(next: JobState, previous: JobState | null): Promise<void> {
  await redis().set(jobKey(next.jobId), JSON.stringify(next), { ex: JOB_TTL_S });
  // Only add to the completed index on the transition into "complete" — not
  // on every subsequent write — so the ZSET score reflects the actual
  // completion time.
  if (next.status === "complete" && previous?.status !== "complete") {
    await redis().zadd(COMPLETED_INDEX, {
      score: Date.now(),
      member: next.jobId,
    });
  }
}
