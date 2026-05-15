import "server-only";
import { env } from "./env";

/**
 * SerpAPI Google search client. Server-side only.
 *
 * Used in two places by the scrape pipeline:
 *   1. Resolver — find a person's LinkedIn URL from a company name/URL
 *      (`site:linkedin.com/in "<company>" CEO|founder|owner|president`)
 *   2. Website discovery — find a company's website from its name, prefer the
 *      knowledge graph site field, fall back to the top non-social organic
 *      result.
 *
 * Docs: https://serpapi.com/search-api
 */

const BASE_URL = "https://serpapi.com/search.json";

export class SerpApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = "SerpApiError";
    this.status = status;
    this.body = body;
  }
}

export interface OrganicResult {
  position: number;
  title: string;
  link: string;
  snippet?: string;
  displayed_link?: string;
}

export interface KnowledgeGraph {
  title?: string;
  type?: string;
  website?: string;
  description?: string;
  [key: string]: unknown;
}

export interface SerpSearchResult {
  organic_results?: OrganicResult[];
  knowledge_graph?: KnowledgeGraph;
  search_metadata?: { status?: string };
}

export async function search(
  query: string,
  opts: { num?: number; location?: string } = {}
): Promise<SerpSearchResult> {
  if (!env.SERPAPI_KEY) {
    throw new SerpApiError(0, null, "SERPAPI_KEY is not set");
  }

  const params = new URLSearchParams({
    engine: "google",
    q: query,
    api_key: env.SERPAPI_KEY,
    num: String(opts.num ?? 10),
  });
  if (opts.location) params.set("location", opts.location);

  const resp = await fetch(`${BASE_URL}?${params}`);
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
        ? String((json as { error: unknown }).error)
        : `SerpAPI ${resp.status} ${resp.statusText}`;
    throw new SerpApiError(resp.status, json, message);
  }

  return (json ?? {}) as SerpSearchResult;
}
