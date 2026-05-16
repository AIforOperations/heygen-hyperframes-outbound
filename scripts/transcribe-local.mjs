#!/usr/bin/env node
/**
 * Extract audio from a local MP4 with ffmpeg, send to ElevenLabs Scribe v1,
 * and write the transcript + word timings into the matching .json sidecar.
 *
 *   node scripts/transcribe-local.mjs <video.mp4>
 */

import { readFileSync, writeFileSync, existsSync, createReadStream, statSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { randomBytes } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");

const envText = readFileSync(path.join(REPO, ".env.local"), "utf8");
const elevenKey = (envText.match(/^ELEVENLABS_API_KEY=(.+)$/m) || [])[1]?.trim();
if (!elevenKey) {
  console.error("ELEVENLABS_API_KEY missing from .env.local");
  process.exit(1);
}

const videoArg = process.argv[2];
if (!videoArg) {
  console.error("usage: node scripts/transcribe-local.mjs <video.mp4>");
  process.exit(2);
}
const videoPath = path.resolve(REPO, videoArg);
if (!existsSync(videoPath)) {
  console.error("not found: " + videoPath);
  process.exit(1);
}

// 1) ffmpeg → mp3
const audioPath = path.join(os.tmpdir(), `scribe-${randomBytes(4).toString("hex")}.mp3`);
console.log("→ extracting audio …");
await new Promise((resolve, reject) => {
  const p = spawn("ffmpeg", ["-y", "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", audioPath], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  p.stderr.on("data", (d) => { stderr += d; });
  p.on("close", (code) => code === 0 ? resolve() : reject(new Error("ffmpeg failed: " + stderr.slice(-400))));
});
console.log("  audio: " + audioPath + " (" + statSync(audioPath).size + " B)");

// 2) Scribe
console.log("→ sending to ElevenLabs Scribe v1 …");
const fd = new FormData();
const audioBytes = readFileSync(audioPath);
fd.set("file", new Blob([audioBytes], { type: "audio/mpeg" }), path.basename(audioPath));
fd.set("model_id", "scribe_v1");

const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
  method: "POST",
  headers: { "xi-api-key": elevenKey },
  body: fd,
});
if (!res.ok) {
  console.error("Scribe failed: " + res.status + " " + (await res.text()));
  process.exit(1);
}
const result = await res.json();

const sidecarPath = videoPath.replace(/\.mp4$/, ".json");
let sidecar = {};
if (existsSync(sidecarPath)) sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
sidecar.transcript = result.text;
sidecar.wordTimestamps = result.words || null;
sidecar.languageCode = result.language_code;
writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2));

console.log("\n✓ transcript:");
console.log(result.text);
console.log("\n  words: " + (result.words?.length ?? 0));
console.log("  sidecar updated: " + path.relative(REPO, sidecarPath));
