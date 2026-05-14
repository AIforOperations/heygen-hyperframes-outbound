import "server-only";

/**
 * Server-only env access. Importing this from a Client Component throws at
 * build time — that's the guardrail that keeps secrets out of the browser
 * bundle.
 *
 * Access is lazy: a missing key only throws when something tries to READ it.
 * That way a route that needs only HEYGEN_API_KEY doesn't crash because
 * ANTHROPIC_API_KEY happens to be unset.
 */

const REQUIRED = ["HEYGEN_API_KEY", "ANTHROPIC_API_KEY", "ELEVENLABS_API_KEY"] as const;
const OPTIONAL = ["APIFY_TOKEN", "SERPAPI_KEY"] as const;

type Required = (typeof REQUIRED)[number];
type Optional = (typeof OPTIONAL)[number];

interface Env {
  HEYGEN_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  ELEVENLABS_API_KEY: string;
  APIFY_TOKEN: string | undefined;
  SERPAPI_KEY: string | undefined;
  SITE_URL: string;
}

function readRequired(key: Required): string {
  const value = process.env[key];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required env var: ${key}. ` +
        `Copy .env.example to .env.local and fill it in, then restart the dev server. ` +
        `For production, add it via "vercel env add ${key}".`
    );
  }
  return value;
}

function readOptional(key: Optional): string | undefined {
  const value = process.env[key];
  return value && value.trim() !== "" ? value : undefined;
}

function siteUrl(): string {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3030";
}

export const env: Env = new Proxy({} as Env, {
  get(_target, prop) {
    if (prop === "SITE_URL") return siteUrl();
    if ((REQUIRED as readonly string[]).includes(prop as string)) {
      return readRequired(prop as Required);
    }
    if ((OPTIONAL as readonly string[]).includes(prop as string)) {
      return readOptional(prop as Optional);
    }
    return undefined;
  },
});
