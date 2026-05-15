import "server-only";
import { env } from "./env";

/**
 * Apify run-sync client. Server-side only.
 *
 * We use the "run-sync-get-dataset-items" endpoint, which runs an actor and
 * returns its dataset items in a single HTTP call — no polling, no run IDs to
 * track. Suitable for our small per-lead scrapes that finish well under the
 * function timeout.
 *
 * Docs: https://docs.apify.com/api/v2#/reference/actors/run-actor-synchronously-and-get-dataset-items
 */

const BASE_URL = "https://api.apify.com/v2";

export class ApifyError extends Error {
  status: number;
  body: unknown;
  actorId: string;
  constructor(actorId: string, status: number, body: unknown, message: string) {
    super(message);
    this.name = "ApifyError";
    this.actorId = actorId;
    this.status = status;
    this.body = body;
  }
}

/**
 * Run an actor and wait for it to finish. Returns the array of dataset items
 * the actor pushed.
 *
 * `actorId` accepts both forms — "username/actor-name" or "actor~id". We
 * always URL-encode the slash to "~" since Apify's path syntax requires it.
 */
export async function runActorSync<TItem = unknown, TInput = unknown>(
  actorId: string,
  input: TInput,
  opts: { timeoutSecs?: number; memoryMbytes?: number } = {}
): Promise<TItem[]> {
  if (!env.APIFY_TOKEN) {
    throw new ApifyError(actorId, 0, null, "APIFY_TOKEN is not set");
  }

  const slug = actorId.replace("/", "~");
  const params = new URLSearchParams({ token: env.APIFY_TOKEN });
  if (opts.timeoutSecs) params.set("timeout", String(opts.timeoutSecs));
  if (opts.memoryMbytes) params.set("memory", String(opts.memoryMbytes));

  const url = `${BASE_URL}/acts/${slug}/run-sync-get-dataset-items?${params}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  const text = await resp.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      /* keep null */
    }
  }

  if (!resp.ok) {
    const message =
      json && typeof json === "object" && "error" in json
        ? JSON.stringify((json as { error: unknown }).error)
        : `Apify ${resp.status} ${resp.statusText}`;
    throw new ApifyError(actorId, resp.status, json, message);
  }

  if (!Array.isArray(json)) {
    throw new ApifyError(
      actorId,
      resp.status,
      json,
      `Expected array from Apify, got ${typeof json}`
    );
  }

  return json as TItem[];
}
