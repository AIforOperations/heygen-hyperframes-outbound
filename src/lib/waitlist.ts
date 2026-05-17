import "server-only";
import { Redis } from "@upstash/redis";

/**
 * Waitlist email capture, backed by the same Upstash Redis instance as
 * job state. Dedupes by lowercased email — second signup from the same
 * address updates the timestamp instead of creating a duplicate row.
 *
 * Layout in Redis:
 *   lf:waitlist           → ZSET, score = signup ms, member = email
 *   lf:waitlist:meta:<email> → JSON (userAgent + referer) optional
 */

const WAITLIST_KEY = "lf:waitlist";
const META_PREFIX = "lf:waitlist:meta:";
const META_TTL_S = 365 * 24 * 60 * 60; // 1 year

let _redis: Redis | null = null;
function redis(): Redis {
  if (_redis) return _redis;
  const url =
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error(
      "Upstash Redis env vars missing: set KV_REST_API_URL + KV_REST_API_TOKEN"
    );
  }
  _redis = new Redis({ url, token });
  return _redis;
}

export interface WaitlistEntry {
  email: string;
  capturedAt: string;
  userAgent?: string | null;
  referer?: string | null;
}

export interface AddResult {
  isNew: boolean;
  total: number;
}

/**
 * RFC-5322-ish minimum validation — the common-case regex pattern. Length
 * cap matches the input field on the frontend (254 chars per RFC 5321).
 */
export function isValidEmail(email: string): boolean {
  if (typeof email !== "string") return false;
  const trimmed = email.trim();
  if (trimmed.length < 3 || trimmed.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

export async function addWaitlistEntry(
  email: string,
  meta: { userAgent?: string | null; referer?: string | null } = {}
): Promise<AddResult> {
  const normalized = email.trim().toLowerCase();
  const score = Date.now();
  // zadd without NX/XX returns 1 if member was newly added, 0 if it
  // already existed (in which case its score is updated). Lets us tell
  // the user whether they were already on the list.
  const added = await redis().zadd(WAITLIST_KEY, {
    score,
    member: normalized,
  });
  const isNew = added === 1;

  // Best-effort: store request metadata in a side key, capped to 1y TTL.
  // Failures here don't block the signup.
  if (meta.userAgent || meta.referer) {
    try {
      await redis().set(
        META_PREFIX + normalized,
        JSON.stringify({
          userAgent: meta.userAgent ? meta.userAgent.slice(0, 200) : null,
          referer: meta.referer ? meta.referer.slice(0, 200) : null,
          updatedAt: new Date(score).toISOString(),
        }),
        { ex: META_TTL_S }
      );
    } catch {
      /* ignore metadata write failure */
    }
  }

  const total = await redis().zcard(WAITLIST_KEY);
  return { isNew, total };
}

export async function listWaitlistEntries(
  limit = 100
): Promise<WaitlistEntry[]> {
  // Newest first via reverse range with scores.
  const raw = await redis().zrange(WAITLIST_KEY, 0, limit - 1, {
    rev: true,
    withScores: true,
  });
  if (!Array.isArray(raw)) return [];

  const out: WaitlistEntry[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const email = String(raw[i]);
    const score = Number(raw[i + 1]);
    if (!email || !Number.isFinite(score)) continue;
    const entry: WaitlistEntry = {
      email,
      capturedAt: new Date(score).toISOString(),
    };
    out.push(entry);
  }

  // Hydrate metadata for each entry in parallel — small N (limit ≤500).
  await Promise.all(
    out.map(async (e) => {
      try {
        const m = await redis().get<string>(META_PREFIX + e.email);
        if (m) {
          const parsed = typeof m === "string" ? JSON.parse(m) : m;
          e.userAgent = parsed?.userAgent ?? null;
          e.referer = parsed?.referer ?? null;
        }
      } catch {
        /* skip */
      }
    })
  );

  return out;
}

export async function waitlistCount(): Promise<number> {
  return await redis().zcard(WAITLIST_KEY);
}
