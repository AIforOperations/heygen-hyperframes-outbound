import "server-only";
import { runActorSync } from "./apify";
import { resolveToPerson, type ScrapeInput, type ResolvedTarget } from "./resolve";
import { crawlHomepage, discoverWebsite, domainFromUrl, type WebsiteSummary } from "./website";

/**
 * Scrape orchestrator. Single entry point: `scrapeLead(input)` → normalized
 * `Lead`. Coordinates resolver, two harvestapi LinkedIn actors, website
 * discovery, homepage crawl, and Clearbit logo URL construction.
 *
 * Actors (locked, both harvestapi):
 *   - linkedin-profile-scraper  → identity, headline, current role, photo
 *   - linkedin-profile-posts    → recent activity (maxPosts: 5,
 *                                  postedLimit: "month")
 *
 * Parallelism rules:
 *   - profile + posts always run in parallel (independent given personUrl)
 *   - website discovery + crawl run as soon as we have a companyName: this
 *     means concurrently with profile/posts when input is companyName or
 *     companyUrl, and sequentially after profile when input is personUrl
 */

const PROFILE_ACTOR = "harvestapi/linkedin-profile-scraper";
const POSTS_ACTOR = "harvestapi/linkedin-profile-posts";

export interface LeadHook {
  text: string;
  postedAt: string | null;
  type: "post" | "repost" | "comment" | "article" | "other";
  url: string | null;
}

export interface LeadCompany {
  name: string | null;
  linkedinUrl: string | null;
  websiteUrl: string | null;
  domain: string | null;
  logoUrl: string | null;
}

export interface Lead {
  firstName: string | null;
  fullName: string | null;
  role: string | null;
  headline: string | null;
  photoUrl: string | null;
  tenureMonths: number | null;
  about: string | null;
  linkedinUrl: string;

  company: LeadCompany;
  hooks: LeadHook[];
  website: WebsiteSummary | null;
}

export interface ScrapeStages {
  resolve?: { ms: number; result?: unknown };
  profile?: { ms: number; result?: unknown };
  posts?: { ms: number; result?: unknown };
  website?: { ms: number; result?: unknown };
}

export interface ScrapeResult {
  lead: Lead;
  stages: ScrapeStages;
  totalMs: number;
}

// ----- harvestapi defensive parsing -----
//
// We don't pin a strict schema for the actor output. harvestapi's exact field
// names drift between revisions, so we pick the first present alias for each
// piece of data we need. Anything missing degrades gracefully.

function pickString(obj: unknown, ...keys: string[]): string | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function pickObj(obj: unknown, ...keys: string[]): Record<string, unknown> | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = o[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  }
  return null;
}

function pickArray(obj: unknown, ...keys: string[]): unknown[] {
  if (!obj || typeof obj !== "object") return [];
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = o[k];
    if (Array.isArray(v)) return v;
  }
  return [];
}

/** Pulls a URL out of an image-shaped field that can be either a string or
 * `{ url, sizes: [{ url, width, height }] }`. */
function pickImageUrl(obj: unknown, ...keys: string[]): string | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const url = (v as Record<string, unknown>).url;
      if (typeof url === "string" && url.trim()) return url.trim();
    }
  }
  return null;
}

/** harvestapi startDate is `{ month: "Apr", year: 2024, text: "Apr 2024" }`.
 * Accepts either that or a plain string ("YYYY-MM"). */
function tenureMonthsFrom(startDate: unknown): number | null {
  if (!startDate) return null;
  let year: number | null = null;
  let month: number | null = null;

  if (typeof startDate === "string") {
    const m = startDate.match(/^(\d{4})-(\d{1,2})/);
    if (!m) return null;
    year = Number(m[1]);
    month = Number(m[2]);
  } else if (typeof startDate === "object") {
    const o = startDate as Record<string, unknown>;
    if (typeof o.year === "number") year = o.year;
    if (typeof o.year === "string") year = Number(o.year);
    const mo = o.month;
    if (typeof mo === "number") month = mo;
    else if (typeof mo === "string") {
      const named = MONTH_NAMES.indexOf(mo.slice(0, 3).toLowerCase());
      if (named >= 0) month = named + 1;
      else if (/^\d+$/.test(mo)) month = Number(mo);
    }
  }

  if (!year || !month || !Number.isFinite(year) || !Number.isFinite(month)) {
    return null;
  }
  const start = new Date(Date.UTC(year, month - 1, 1));
  const now = new Date();
  const months =
    (now.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - start.getUTCMonth());
  return months >= 0 ? months : null;
}

const MONTH_NAMES = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];

function classifyPostType(raw: string | null): LeadHook["type"] {
  if (!raw) return "post";
  const t = raw.toLowerCase();
  if (t.includes("repost") || t.includes("share")) return "repost";
  if (t.includes("comment")) return "comment";
  if (t.includes("article")) return "article";
  if (t.includes("post")) return "post";
  return "other";
}

function normalizeProfile(item: unknown): {
  firstName: string | null;
  fullName: string | null;
  role: string | null;
  headline: string | null;
  photoUrl: string | null;
  about: string | null;
  tenureMonths: number | null;
  companyName: string | null;
  companyLinkedinUrl: string | null;
} {
  const firstName = pickString(item, "firstName", "first_name");
  const lastName = pickString(item, "lastName", "last_name");
  const fullName =
    pickString(item, "fullName", "name", "full_name") ||
    [firstName, lastName].filter(Boolean).join(" ") ||
    null;

  const headline = pickString(item, "headline", "title", "subtitle");
  const photoUrl = pickImageUrl(
    item,
    "profilePicture",
    "photoUrl",
    "profilePictureUrl",
    "pictureUrl",
    "avatar"
  );
  const about = pickString(item, "about", "summary", "bio");

  // harvestapi: currentPosition is an array of position objects. Some variants
  // use experience[] / positions[] / a singleton object.
  const positionsArr = pickArray(
    item,
    "currentPosition",
    "experience",
    "experiences",
    "positions"
  );
  const current: Record<string, unknown> | null =
    (positionsArr[0] as Record<string, unknown> | undefined) ??
    pickObj(item, "current_position", "position") ??
    null;

  const role =
    pickString(current, "position", "title", "role") ||
    pickString(item, "currentRole");
  const companyName =
    pickString(current, "companyName", "company", "company_name") ||
    pickString(item, "companyName", "company");
  const companyLinkedinUrl =
    pickString(current, "companyLinkedinUrl", "companyUrl", "company_url") ||
    pickString(item, "companyLinkedinUrl", "companyUrl");

  const startedAt =
    (current && (current.startDate ?? current.startedAt ?? current.from)) ?? null;
  const tenureMonths = tenureMonthsFrom(startedAt);

  return {
    firstName,
    fullName,
    role,
    headline,
    photoUrl,
    about,
    tenureMonths,
    companyName,
    companyLinkedinUrl,
  };
}

function normalizePosts(items: unknown[]): LeadHook[] {
  const hooks: LeadHook[] = [];
  for (const it of items) {
    // harvestapi posts wrap text in different keys depending on type
    const text =
      pickString(it, "text", "content", "commentary", "description") || "";
    if (!text) continue;
    const postedAt =
      pickString(it, "postedAt", "posted_at", "publishedAt", "date") || null;
    const type = classifyPostType(pickString(it, "type", "postType", "kind"));
    const url = pickString(it, "url", "postUrl", "link");
    hooks.push({
      text: text.length > 1200 ? text.slice(0, 1200) + "…" : text,
      postedAt,
      type,
      url,
    });
  }
  // Newest first if dates parse; otherwise preserve actor order.
  hooks.sort((a, b) => {
    const ta = a.postedAt ? Date.parse(a.postedAt) : 0;
    const tb = b.postedAt ? Date.parse(b.postedAt) : 0;
    return tb - ta;
  });
  return hooks.slice(0, 5);
}

// ----- Actor callers -----

interface ProfileFetchResult {
  ok: boolean;
  url: string;
  data?: unknown;
  error?: string;
  status?: number;
}

async function tryProfile(personUrl: string): Promise<ProfileFetchResult> {
  const items = await runActorSync<Record<string, unknown>>(
    PROFILE_ACTOR,
    {
      queries: [personUrl],
      profileScraperMode: "Profile details no email ($4 per 1k)",
    },
    { timeoutSecs: 120 }
  );
  if (!items.length) {
    return { ok: false, url: personUrl, error: "actor returned 0 items" };
  }
  const first = items[0];
  const status = typeof first.status === "number" ? first.status : undefined;
  if (status && status >= 400) {
    return {
      ok: false,
      url: personUrl,
      status,
      error: typeof first.error === "string" ? first.error : `status ${status}`,
    };
  }
  // Some harvestapi variants nest the profile in `element`. Unwrap if so.
  const data =
    first.element && typeof first.element === "object" ? first.element : first;
  return { ok: true, url: personUrl, data };
}

/**
 * Walks a ranked list of candidate person URLs and returns the first one
 * harvestapi can resolve. Bounds the cost at MAX_CANDIDATES attempts —
 * each failed call still bills, so we don't want to retry the whole list.
 */
async function fetchProfileWithFallback(
  candidates: string[]
): Promise<{ url: string; data: unknown; tried: ProfileFetchResult[] }> {
  const MAX_CANDIDATES = 3;
  const tried: ProfileFetchResult[] = [];
  const limit = Math.min(candidates.length, MAX_CANDIDATES);
  for (let i = 0; i < limit; i++) {
    const result = await tryProfile(candidates[i]);
    tried.push(result);
    if (result.ok) {
      return { url: result.url, data: result.data, tried };
    }
  }
  const last = tried[tried.length - 1];
  throw new Error(
    `${PROFILE_ACTOR} failed for all ${tried.length} candidate(s). Last: ${last?.error ?? "unknown"}`
  );
}

async function callPostsActor(personUrl: string): Promise<unknown[]> {
  return runActorSync<unknown>(
    POSTS_ACTOR,
    {
      profileUrls: [personUrl],
      maxPosts: 5,
      postedLimit: "month",
    },
    { timeoutSecs: 120 }
  );
}

// ----- Website branch -----

async function enrichWebsite(companyName: string | null): Promise<{
  summary: WebsiteSummary | null;
  websiteUrl: string | null;
  domain: string | null;
  logoUrl: string | null;
}> {
  if (!companyName) return { summary: null, websiteUrl: null, domain: null, logoUrl: null };

  let websiteUrl: string | null = null;
  try {
    websiteUrl = await discoverWebsite(companyName);
  } catch {
    websiteUrl = null;
  }

  const summary = websiteUrl ? await crawlHomepage(websiteUrl).catch(() => null) : null;

  const domain = websiteUrl ? domainFromUrl(websiteUrl) : null;
  // Clearbit's free logo API was deprecated and `logo.clearbit.com` no
  // longer resolves DNS. Until we wire up another provider, leave logoUrl
  // null and let the composition's initials-fallback render in its place.
  const logoUrl: string | null = null;

  return { summary, websiteUrl, domain, logoUrl };
}

// ----- Orchestrator -----

export async function scrapeLead(input: ScrapeInput): Promise<ScrapeResult> {
  const startedAt = Date.now();
  const stages: ScrapeStages = {};

  // Step 1: resolve to a personUrl. Also gives us companyName when input is
  // companyName/companyUrl, which lets the website branch start earlier.
  const tResolve = Date.now();
  const resolved: ResolvedTarget = await resolveToPerson(input);
  stages.resolve = {
    ms: Date.now() - tResolve,
    result: {
      personUrl: resolved.personUrl,
      candidateCount: resolved.candidates.length,
      companyName: resolved.companyName,
    },
  };

  // Step 2: profile first (with candidate fallback), then posts on the *resolved*
  // URL. We can't run posts in parallel with profile here because we don't know
  // which candidate will succeed — running posts against a 404 URL still costs.
  //
  // If we already have a companyName, kick off the website branch concurrently
  // with the profile scrape.
  const earlyWebsite = resolved.companyName
    ? enrichWebsite(resolved.companyName)
    : null;

  const tProfile = Date.now();
  const profileFetch = await fetchProfileWithFallback(resolved.candidates);
  stages.profile = {
    ms: Date.now() - tProfile,
    result: {
      url: profileFetch.url,
      attempts: profileFetch.tried.map((tr) => ({
        url: tr.url,
        ok: tr.ok,
        status: tr.status,
        error: tr.error,
      })),
    },
  };

  const tPosts = Date.now();
  const postsRaw = await callPostsActor(profileFetch.url);
  stages.posts = { ms: Date.now() - tPosts, result: { count: postsRaw.length } };

  const profile = normalizeProfile(profileFetch.data);
  const hooks = normalizePosts(postsRaw);
  // The resolved URL may differ from candidates[0] if the first candidate 404'd.
  const personUrl = profileFetch.url;

  // Step 3: website branch, late path. Only runs if it wasn't already kicked off.
  let websiteBranch = earlyWebsite;
  if (!websiteBranch) {
    const name = profile.companyName ?? null;
    websiteBranch = enrichWebsite(name);
  }

  const tWebsite = Date.now();
  const { summary, websiteUrl, domain, logoUrl } = await websiteBranch;
  stages.website = {
    ms: Date.now() - tWebsite,
    result: { websiteUrl, hasSummary: Boolean(summary) },
  };

  const lead: Lead = {
    firstName: profile.firstName,
    fullName: profile.fullName,
    role: profile.role,
    headline: profile.headline,
    photoUrl: profile.photoUrl,
    tenureMonths: profile.tenureMonths,
    about: profile.about,
    linkedinUrl: personUrl,
    company: {
      name: profile.companyName ?? resolved.companyName,
      linkedinUrl: profile.companyLinkedinUrl ?? resolved.companyLinkedinUrl,
      websiteUrl,
      domain,
      logoUrl,
    },
    hooks,
    website: summary,
  };

  return { lead, stages, totalMs: Date.now() - startedAt };
}
