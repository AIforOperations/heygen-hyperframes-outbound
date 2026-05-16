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
  logoUrl: string | null;
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

  // Pull anything that lives in <head> BEFORE the noise sweep removes <meta>
  // and <link>. Order matters here — the previous version stripped first and
  // then read meta/link, which silently returned null for everything in <head>.
  const title = $("title").first().text().trim() || null;
  const metaDescription =
    $('meta[name="description"]').attr("content")?.trim() ||
    $('meta[property="og:description"]').attr("content")?.trim() ||
    null;
  const logoUrl = await extractLogoUrl($, finalUrl);

  // Strip noise so .text() below isn't full of script bodies.
  $("script, style, noscript, svg, iframe, link, meta").remove();

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
    logoUrl,
  };
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr.map((s) => s.trim())));
}

export function domainFromUrl(url: string): string | null {
  return hostOf(url);
}

// ---------- Logo extraction (SMB-tuned) ----------
//
// The composition's intro-v1 scene renders the logo into an 84×84 square
// badge with `object-fit: contain` and white padding. That means rectangular
// banners (og:image, typically 1200×630) get letterboxed and look shrunken,
// while square assets fill the badge cleanly. SMBs add a wrinkle: og:image
// is often a stock theme banner (a skyscraper photo for a real estate office,
// a generic kitchen for a contractor), which would look terrible cropped
// into the logo card. The CMS-uploaded apple-touch-icon is the closest thing
// to "their actual logo" on most SMB sites.
//
// Priority:
//   1. apple-touch-icon         — square, on-brand, designed for icon use.
//                                  WordPress / Wix / Squarespace auto-generate
//                                  this at 180×180 from the uploaded site icon.
//                                  Strongest signal of "their actual logo."
//   2. msapplication-TileImage  — square, often the same asset as #1.
//   3. link[rel="icon"] ≥64px   — explicit larger favicons; SVGs land here
//                                  (vector scales cleanly to any size).
//   4. og:image                 — rectangular banner. Letterboxes in the
//                                  square slot, and for SMBs the asset may be
//                                  a stock theme image — but better than no
//                                  logo at all when nothing square exists.
//   5. small link[rel="icon"]   — last resort. Usually a 16/32px favicon.
//   6. Convention paths         — `/apple-touch-icon.png`, `/favicon.ico` at
//                                  the site root. Many SMB CMSes serve these
//                                  by default even when not declared in <head>.
//                                  HEAD-checked because we can't otherwise
//                                  tell if they exist.
//
// All URLs are absolutized against the final crawl URL (after redirects). We
// trust declared URLs — no HEAD verification — because the cost of an extra
// ~300ms per render is not worth the rare bad-URL case (the composition's
// initials fallback already handles broken images). Convention paths ARE
// HEAD-checked because they're guesses.

async function extractLogoUrl(
  $: cheerio.CheerioAPI,
  baseUrl: string
): Promise<string | null> {
  const candidates: string[] = [];

  const sized = (sel: string): Array<{ href: string; size: number }> => {
    const out: Array<{ href: string; size: number }> = [];
    $(sel).each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      const sizesAttr = $(el).attr("sizes") || "";
      // sizes can be "any", "192x192", or space-separated "16x16 32x32".
      // Take the largest dimension we can parse.
      const parsed = sizesAttr
        .split(/\s+/)
        .map((s) => parseInt(s.split("x")[0], 10))
        .filter((n) => Number.isFinite(n) && n > 0);
      const size = parsed.length ? Math.max(...parsed) : 0;
      out.push({ href, size });
    });
    return out.sort((a, b) => b.size - a.size);
  };

  // 1. apple-touch-icon (largest declared size first)
  for (const c of sized(
    'link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]'
  )) {
    candidates.push(c.href);
  }

  // 2. msapplication-TileImage
  const tile = $('meta[name="msapplication-TileImage"]').attr("content");
  if (tile) candidates.push(tile);

  // 3. Larger link[rel="icon"] entries (≥64px or SVG)
  const iconCandidates = sized(
    'link[rel="icon"], link[rel="shortcut icon"]'
  );
  for (const c of iconCandidates) {
    const isSvg = /\.svg(\?|$)/i.test(c.href);
    if (isSvg || c.size >= 64) candidates.push(c.href);
  }

  // 4. og:image (rectangular fallback)
  const og =
    $('meta[property="og:image"]').attr("content") ||
    $('meta[name="og:image"]').attr("content") ||
    $('meta[property="og:image:secure_url"]').attr("content");
  if (og) candidates.push(og);

  // 5. Remaining smaller favicons
  for (const c of iconCandidates) {
    const isSvg = /\.svg(\?|$)/i.test(c.href);
    if (!isSvg && c.size < 64) candidates.push(c.href);
  }

  for (const raw of candidates) {
    const abs = absolutizeUrl(raw, baseUrl);
    if (!abs) continue;
    if (abs.startsWith("data:image/")) return abs;
    if (abs.startsWith("http://") || abs.startsWith("https://")) return abs;
  }

  // 6. Convention-path fallback. Many SMB CMSes (WordPress, Wix, Squarespace,
  // GoDaddy) serve these at the well-known paths even when nothing is
  // declared in <head>. HEAD-check each in order. Bounded to 3s per check
  // and 3 checks total (≤9s worst case).
  const conventionPaths = [
    "/apple-touch-icon.png",
    "/apple-touch-icon-precomposed.png",
    "/favicon.ico",
  ];
  for (const p of conventionPaths) {
    const abs = absolutizeUrl(p, baseUrl);
    if (!abs) continue;
    if (await urlExists(abs)) return abs;
  }

  return null;
}

function absolutizeUrl(maybeRelative: string, baseUrl: string): string | null {
  try {
    return new URL(maybeRelative.trim(), baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Cheap HEAD-check that returns true only when the response is a 2xx with an
 * image-y content type. Bounded to 3s.
 */
async function urlExists(url: string): Promise<boolean> {
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 3000);
  try {
    const resp = await fetch(url, {
      method: "HEAD",
      signal: ac.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      },
    });
    if (!resp.ok) return false;
    const ct = resp.headers.get("content-type") || "";
    // Some CDNs return text/html on a 404 page served at 200 — accept only
    // when the content-type is missing (some hosts omit it on HEAD) or is
    // image-y. Browsers will accept ico via image/x-icon or image/vnd.microsoft.icon.
    if (!ct) return true;
    return /^image\//i.test(ct) || ct.includes("icon");
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
