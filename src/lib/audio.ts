import "server-only";

/**
 * Download a HeyGen MP4 and return the raw buffer ready to send to ElevenLabs
 * Scribe v1.
 *
 * Why not ffmpeg-extract first: Scribe accepts MP4 directly (audio track is
 * extracted server-side). Vercel's serverless Node runtime doesn't ship with
 * ffmpeg, so spawning it errors with ENOENT. Local dev had ffmpeg via Homebrew
 * which is why it worked there but failed in production.
 *
 * Tradeoff: we upload the full MP4 (~3-10 MB for a 30s clip at 1080p) instead
 * of a small MP3. Scribe's file limit is 1 GB and they handle the extraction,
 * so this is fine.
 */
export async function extractAudioFromVideoUrl(
  videoUrl: string
): Promise<{ buffer: Buffer; contentType: string; filename: string }> {
  const resp = await fetch(videoUrl);
  if (!resp.ok) {
    throw new Error(
      `Failed to download video: ${resp.status} ${resp.statusText}`
    );
  }
  const buffer = Buffer.from(await resp.arrayBuffer());
  return { buffer, contentType: "video/mp4", filename: "input.mp4" };
}
