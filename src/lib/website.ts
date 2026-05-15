import "server-only";
import * as cheerio from "cheerio";
import { search } from "./serpapi";

/**
 * Website enrichment — finds the company's homepage and extracts the bits a
 * 50–60s sales script needs: what they sell (hero/headings), how they talk
 * about themselves (body excerpt), and freshness signals.
 *
 * No JS rendering, no headless browser. Single HTTP GET, cheerio-parse, strip
 * to text. SMB sites are overwhelmingly server-rendered enough for this to
 * work; the few JS-only cases fall back to the SerpAPI snippet via the
 * orchestrator.
 */

export interface WebsiteSummary {
  url: string;
  title: string | null;
  metaDescription: string | null;
  heroText: string | null;
  headings: string[];
  bodyExcerpt: string;
}

const SOCIAL_HOSTS = [
  "linkedin.com",
  "facebook.com",
  "twitter.com",
  "x.com",
  "instagram.com",
  "youtube.com",
  "tiktok.com",
  "crunchbase.com",
  "bloomberg.com",
  "yelp.com",
  "bbb.org",
  "indeed.com",
  "glassdoor.com",
  "wikipedia.org",
];

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function isSocialOrDirectory(url: string): boolean {
  const host = hostOf(url);
  if (!host) return true;
  return SOCIAL_HOSTS.some((s) => host === s || host.endsWith(`.${s}`));
}

/**
 * Best-effort: SerpAPI knowledge graph → top non-social organic result.
 * Returns null if nothing usable is found.
 */
export async function discoverWebsite(companyName: string): Promise<string | null> {
  const result = await search(`${companyName} official website`, { num: 8 });

  const kg = result.knowledge_graph;
  if (kg?.website && typeof kg.website === "string" && !isSocialOrDirectory(kg.website)) {
    return kg.website;
  }

  for (const r of result.organic_results ?? []) {
    if (!isSocialOrDirectory(r.link)) {
      return r.link;
    }
  }
  return null;
}

/**
 * Fetches a homepage and extracts structured text. Times out at 10s. Returns
 * null on any network/parse failure — orchestrator decides whether to fall
 * back.
 */
export async function crawlHomepage(url: string): Promise<WebsiteSummary | null> {
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 10_000);

  let html: string;
  let finalUrl = url;
  try {
    const resp = await fetch(url, {
      signal: ac.signal,
      redirect: "follow",
      headers: {
        // A real-browser UA reduces 403s from defensive WAFs.
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    finalUrl = resp.url || url;
    if (!resp.ok) return null;
    html = await resp.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }

  if (!html || html.length < 200) return null;

  const $ = cheerio.load(html);

  // Strip noise so .text() below isn't full of script bodies.
  $("script, style, noscript, svg, iframe, link, meta").remove();

  const title = $("title").first().text().trim() || null;
  const metaDescription =
    $('meta[name="description"]').attr("content")?.trim() ||
    $('meta[property="og:description"]').attr("content")?.trim() ||
    null;

  // Hero = the first chunk of visible text from main/header/h1. SMB hero
  // sections usually live there. Strip whitespace runs.
  const heroCandidate =
    $("main h1").first().text() ||
    $("header h1").first().text() ||
    $("h1").first().text() ||
    "";
  const heroText = heroCandidate.replace(/\s+/g, " ").trim() || null;

  // Headings expose nav/service-list structure — high signal, low cost.
  const headings: string[] = [];
  $("h1, h2, h3").each((_, el) => {
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (t && t.length >= 3 && t.length <= 200) headings.push(t);
  });

  // Body excerpt — the gist of what they say about themselves.
  $("nav, footer, aside, form").remove();
  const rawBody = ($("main").text() || $("body").text() || "")
    .replace(/\s+/g, " ")
    .trim();
  const bodyExcerpt = rawBody.slice(0, 1500);

  return {
    url: finalUrl,
    title,
    metaDescription,
    heroText,
    headings: dedupe(headings).slice(0, 25),
    bodyExcerpt,
  };
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr.map((s) => s.trim())));
}

export function domainFromUrl(url: string): string | null {
  return hostOf(url);
}
