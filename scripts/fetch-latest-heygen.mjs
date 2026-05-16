#!/usr/bin/env node
/**
 * Fetch the most recent video from the user's HeyGen account, download the
 * MP4, and write a JSON sidecar with metadata (script, voice, avatar, etc).
 *
 * Usage:
 *   node scripts/fetch-latest-heygen.mjs                 # picks newest
 *   node scripts/fetch-latest-heygen.mjs --limit 10      # list 10, pick newest
 */

import { readFileSync, writeFileSync, createWriteStream, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");

// Load HEYGEN_API_KEY from .env.local
const envPath = path.join(REPO, ".env.local");
if (!existsSync(envPath)) {
  console.error(".env.local not found at " + envPath);
  process.exit(1);
}
const envText = readFileSync(envPath, "utf8");
const apiKey = (envText.match(/^HEYGEN_API_KEY=(.+)$/m) || [])[1]?.trim();
if (!apiKey) {
  console.error("HEYGEN_API_KEY missing from .env.local");
  process.exit(1);
}

const limit = parseInt(process.argv.includes("--limit")
  ? process.argv[process.argv.indexOf("--limit") + 1]
  : "20", 10);

console.log(`→ listing last ${limit} HeyGen videos`);
const listRes = await fetch(`https://api.heygen.com/v1/video.list?limit=${limit}`, {
  headers: { "X-Api-Key": apiKey, "Accept": "application/json" },
});
if (!listRes.ok) {
  console.error(`HeyGen list failed: ${listRes.status} ${await listRes.text()}`);
  process.exit(1);
}
const listJson = await listRes.json();
const videos = listJson?.data?.videos || [];
if (!videos.length) {
  console.error("no videos returned by HeyGen");
  process.exit(1);
}

// Sort by created_at desc to be safe (API usually returns newest first already)
videos.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
const newest = videos.find((v) => v.status === "completed") || videos[0];

console.log("→ newest video:");
console.log("  id:        " + newest.video_id);
console.log("  status:    " + newest.status);
console.log("  type:      " + (newest.type || "?"));
console.log("  created:   " + new Date((newest.created_at || 0) * 1000).toISOString());

// Pull full details (includes signed video_url, script, avatar, voice, etc)
const detailRes = await fetch(`https://api.heygen.com/v1/video_status.get?video_id=${newest.video_id}`, {
  headers: { "X-Api-Key": apiKey, "Accept": "application/json" },
});
if (!detailRes.ok) {
  console.error(`video_status.get failed: ${detailRes.status} ${await detailRes.text()}`);
  process.exit(1);
}
const detailJson = await detailRes.json();
const detail = detailJson?.data;
if (!detail) {
  console.error("video_status.get returned no data: " + JSON.stringify(detailJson));
  process.exit(1);
}

const videoUrl = detail.video_url || detail.video_url_caption;
if (!videoUrl) {
  console.error("no video_url in detail response: " + JSON.stringify(detail, null, 2));
  process.exit(1);
}

const duration = detail.duration ?? 0;
const ts = new Date((newest.created_at || Date.now() / 1000) * 1000).toISOString().replace(/[:.]/g, "-");
const slug = `heygen_latest_${newest.video_id.slice(0, 8)}`;
const videoDir = path.join(REPO, "video");
mkdirSync(videoDir, { recursive: true });
const mp4Path = path.join(videoDir, `${slug}.mp4`);
const jsonPath = path.join(videoDir, `${slug}.json`);

console.log("→ downloading mp4 …");
const mp4Res = await fetch(videoUrl);
if (!mp4Res.ok || !mp4Res.body) {
  console.error(`mp4 download failed: ${mp4Res.status}`);
  process.exit(1);
}
await pipeline(mp4Res.body, createWriteStream(mp4Path));
console.log("  saved: " + path.relative(REPO, mp4Path));

const sidecar = {
  fetchedAt: new Date().toISOString(),
  source: "heygen",
  videoId: newest.video_id,
  createdAt: newest.created_at,
  status: newest.status,
  duration,
  type: newest.type,
  // These may or may not appear depending on how the video was generated:
  avatarId: detail.avatar_id || detail.talking_photo_id || null,
  voiceId: detail.voice_id || null,
  script: detail.script || detail.text || detail.caption || null,
  raw: detail,
};
writeFileSync(jsonPath, JSON.stringify(sidecar, null, 2));
console.log("  sidecar: " + path.relative(REPO, jsonPath));

console.log("\n✓ done. Local mp4 path for compiler:");
console.log("  " + path.relative(REPO, mp4Path));
console.log("  duration: " + duration + "s");
if (sidecar.script) {
  console.log("\n  script:");
  console.log("    " + JSON.stringify(sidecar.script).slice(0, 400));
}
