#!/usr/bin/env node
/** Fetch a specific HeyGen video by ID, save MP4 + sidecar. */
import { readFileSync, writeFileSync, createWriteStream, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const envText = readFileSync(path.join(REPO, ".env.local"), "utf8");
const apiKey = (envText.match(/^HEYGEN_API_KEY=(.+)$/m) || [])[1]?.trim();
if (!apiKey) { console.error("HEYGEN_API_KEY missing"); process.exit(1); }

const videoId = process.argv[2];
if (!videoId) { console.error("usage: fetch-heygen-by-id.mjs <video_id>"); process.exit(2); }

const res = await fetch(`https://api.heygen.com/v1/video_status.get?video_id=${videoId}`, {
  headers: { "X-Api-Key": apiKey, "Accept": "application/json" },
});
if (!res.ok) { console.error("API failed: " + res.status); process.exit(1); }
const detail = (await res.json()).data;
const videoUrl = detail.video_url;
if (!videoUrl) { console.error("no video_url: " + JSON.stringify(detail).slice(0,500)); process.exit(1); }

const slug = `heygen_${videoId.slice(0, 8)}`;
mkdirSync(path.join(REPO, "video"), { recursive: true });
const mp4 = path.join(REPO, "video", `${slug}.mp4`);
const json = path.join(REPO, "video", `${slug}.json`);

console.log("→ downloading mp4 …");
const mp4Res = await fetch(videoUrl);
await pipeline(mp4Res.body, createWriteStream(mp4));
writeFileSync(json, JSON.stringify({
  fetchedAt: new Date().toISOString(),
  videoId, duration: detail.duration, status: detail.status,
  raw: detail,
}, null, 2));
console.log("✓ " + path.relative(REPO, mp4));
console.log("  duration: " + detail.duration + "s");
