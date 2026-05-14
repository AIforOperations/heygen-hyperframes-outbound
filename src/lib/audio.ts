import "server-only";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Extract audio from a video URL using ffmpeg. Returns the audio bytes
 * (MP3, 128kbps, mono, 16kHz) — a format Scribe v1 accepts and that keeps
 * the upload payload small.
 *
 * Requires ffmpeg on PATH. Available on macOS via Homebrew and on Vercel
 * Sandbox if baked into the snapshot.
 */
export async function extractAudioFromVideoUrl(
  videoUrl: string
): Promise<{ buffer: Buffer; contentType: string; filename: string }> {
  const videoResp = await fetch(videoUrl);
  if (!videoResp.ok) {
    throw new Error(
      `Failed to download video: ${videoResp.status} ${videoResp.statusText}`
    );
  }
  const videoBytes = Buffer.from(await videoResp.arrayBuffer());

  const workDir = await fs.mkdtemp(path.join(tmpdir(), "heygen-audio-"));
  const videoPath = path.join(workDir, "input.mp4");
  const audioPath = path.join(workDir, "audio.mp3");
  await fs.writeFile(videoPath, videoBytes);

  try {
    await runFfmpeg([
      "-loglevel", "error",
      "-y",
      "-i", videoPath,
      "-vn",                  // no video
      "-acodec", "libmp3lame",
      "-ar", "16000",         // 16kHz sample rate (sufficient for STT)
      "-ac", "1",             // mono
      "-b:a", "64k",
      audioPath,
    ]);
    const buffer = await fs.readFile(audioPath);
    return { buffer, contentType: "audio/mpeg", filename: "audio.mp3" };
  } finally {
    // Best-effort cleanup
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", (err) => {
      reject(new Error(`ffmpeg spawn failed: ${err.message}`));
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`));
    });
  });
}
