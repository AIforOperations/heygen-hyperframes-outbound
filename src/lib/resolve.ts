import "server-only";
import { search } from "./serpapi";

/**
 * Resolver layer for the scrape pipeline. Whatever the user types, we end up
 * with a LinkedIn person URL (and best-effort company name) that downstream
 * scrapers can use.
 *
 * Inputs:
 *   - personUrl      : pass through
 *   - companyUrl     : derive company slug from the URL, search for a top
 *                      decision-maker at that company
 *   - companyName    : search for a top decision-maker at that company
 *
 * The "top decision-maker" search uses Google as an indirect index into
 * LinkedIn — `site:linkedin.com/in "<company>" (CEO OR founder OR owner OR
 * president)`. SerpAPI charges per query, but this is one call per scrape and
 * far cheaper / faster than running an Apify People Search actor.
 */

export type ScrapeInput =
  | { kind: "personUrl"; value: string }
  | { kind: "companyUrl"; value: string }
  | { kind: "companyName"; value: string };

export interface ResolvedTarget {
  /** Best-guess primary person URL. Equals `candidates[0]`. */
  personUrl: string;
  /** Ranked list of LinkedIn /in/ URLs to try. Caller falls through on failure. */
  candidates: string[];
  companyName: string | null;
  companyLinkedinUrl: string | null;
}

const DECISION_MAKER_TITLES = "(CEO OR founder OR owner OR president OR director)";

function companySlugFromUrl(url: string): string | null {
  // matches /company/<slug>(/...|$)
  const m = url.match(/linkedin\.com\/company\/([^/?#]+)/i);
  if (!m) return null;
  return decodeURIComponent(m[1]).replace(/-/g, " ");
}

function normalizeLinkedinPersonUrl(url: string): string {
  // Strip query/fragment, normalize trailing slash, lowercase host
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    u.search = "";
    u.hash = "";
    return `${u.origin}${u.pathname.replace(/\/$/, "")}`;
  } catch {
    return url;
  }
}

function isLinkedinPersonResult(link: string): boolean {
  return /linkedin\.com\/in\/[^/?#]+/i.test(link);
}

async function findCandidatesForCompany(
  companyName: string,
  companyLinkedinUrl: string | null
): Promise<string[]> {
  const titled = await search(
    `site:linkedin.com/in "${companyName}" ${DECISION_MAKER_TITLES}`,
    { num: 10 }
  );
  const titledHits = (titled.organic_results ?? [])
    .filter((r) => isLinkedinPersonResult(r.link))
    .map((r) => normalizeLinkedinPersonUrl(r.link));

  // Always also run the loose query so we have fall-through options when the
  // titled hits 404 in harvestapi (custom vanity URLs sometimes do).
  const loose = await search(`site:linkedin.com/in "${companyName}"`, { num: 10 });
  const looseHits = (loose.organic_results ?? [])
    .filter((r) => isLinkedinPersonResult(r.link))
    .map((r) => normalizeLinkedinPersonUrl(r.link));

  const merged = dedupeOrdered([...titledHits, ...looseHits]);
  if (!merged.length) {
    throw new Error(
      `No LinkedIn profile found for company "${companyName}"` +
        (companyLinkedinUrl ? ` (${companyLinkedinUrl})` : "")
    );
  }
  return merged;
}

function dedupeOrdered(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of arr) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

export async function resolveToPerson(input: ScrapeInput): Promise<ResolvedTarget> {
  if (input.kind === "personUrl") {
    const url = normalizeLinkedinPersonUrl(input.value);
    return {
      personUrl: url,
      candidates: [url],
      companyName: null,
      companyLinkedinUrl: null,
    };
  }

  if (input.kind === "companyUrl") {
    const slug = companySlugFromUrl(input.value);
    if (!slug) {
      throw new Error(`Could not parse company slug from URL: ${input.value}`);
    }
    const candidates = await findCandidatesForCompany(slug, input.value);
    return {
      personUrl: candidates[0],
      candidates,
      companyName: slug,
      companyLinkedinUrl: input.value,
    };
  }

  // companyName
  const candidates = await findCandidatesForCompany(input.value, null);
  return {
    personUrl: candidates[0],
    candidates,
    companyName: input.value,
    companyLinkedinUrl: null,
  };
}
