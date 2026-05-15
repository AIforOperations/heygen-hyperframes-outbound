import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { extractAudioFromVideoUrl } from "@/lib/audio";
import {
  createVideo,
  getAvatarLook,
  getVideo,
  HeyGenError,
} from "@/lib/heygen";
import { ElevenLabsError, transcribeAudio } from "@/lib/elevenlabs";

/**
 * POST /api/test/generate-video
 *
 * Full pipeline test:
 *   1. Look up the avatar's default voice (whatever HeyGen ships for it)
 *   2. Create video with that voice via /v3/videos (Avatar V engine, script in)
 *   3. Poll until completed
 *   4. Download MP4 + extract audio via ffmpeg
 *   5. Send audio to ElevenLabs Scribe v1 for word-level timestamps
 *
 * Body:
 *   {
 *     avatarId: string
 *     script: string
 *     voiceId?: string           // overrides avatar default
 *     engine?: "avatar_v" | "avatar_iv"
 *     pollTimeoutMs?: number
 *     skipTranscription?: boolean // for speed during development
 *   }
 */
// Hobby plan caps at 300s. HeyGen renders can take 5+ min so this route will
// time out for full E2E tests in production — it's primarily a local dev tool.
// Production flow should use webhooks (see /api/heygen/webhook, todo).
export const maxDuration = 800;

interface RequestBody {
  avatarId: string;
  script: string;
  voiceId?: string;
  engine?: "avatar_v" | "avatar_iv";
  pollTimeoutMs?: number;
  skipTranscription?: boolean;
}

const FALLBACK_VOICE_ID = "007e1378fc454a9f976db570ba6164a7"; // Aria

/**
 * Save the rendered MP4 + a JSON sidecar containing prompt, voice, timestamps,
 * and other metadata, into <project-root>/video/. The MP4 is gitignored; the
 * JSON is committable for reference.
 */
async function saveRenderLocally(opts: {
  videoUrl: string;
  videoId: string;
  metadata: Record<string, unknown>;
}): Promise<{ mp4: string; json: string }> {
  const outDir = path.join(process.cwd(), "video");
  await fs.mkdir(outDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const shortId = opts.videoId.slice(0, 8);
  const base = `render_${stamp}_${shortId}`;
  const mp4Path = path.join(outDir, `${base}.mp4`);
  const jsonPath = path.join(outDir, `${base}.json`);

  const resp = await fetch(opts.videoUrl);
  if (!resp.ok) {
    throw new Error(`Download failed: ${resp.status} ${resp.statusText}`);
  }
  const buffer = Buffer.from(await resp.arrayBuffer());
  await fs.writeFile(mp4Path, buffer);
  await fs.writeFile(jsonPath, JSON.stringify(opts.metadata, null, 2));

  return { mp4: mp4Path, json: jsonPath };
}

export async function POST(req: Request) {
  const startedAt = Date.now();
  const stages: Record<string, { ms: number; result?: unknown }> = {};

  try {
    const body = (await req.json()) as Partial<RequestBody>;
    if (!body.avatarId || !body.script) {
      return NextResponse.json(
        { error: "avatarId and script are required" },
        { status: 400 }
      );
    }

    const engine = body.engine ?? "avatar_v";
    if (engine !== "avatar_v" && engine !== "avatar_iv") {
      return NextResponse.json(
        { error: `Invalid engine "${engine}". Use "avatar_v" or "avatar_iv".` },
        { status: 400 }
      );
    }
    const pollTimeoutMs = body.pollTimeoutMs ?? 10 * 60 * 1000;

    // Stage 1: resolve voice + validate the avatar supports the chosen engine.
    // We fetch the avatar look once and reuse it for both decisions.
    let t = Date.now();
    const look = await getAvatarLook(body.avatarId);

    const supported = look.supported_api_engines ?? [];
    if (!supported.includes(engine)) {
      return NextResponse.json(
        {
          error: `Avatar "${look.name}" does not support engine "${engine}".`,
          avatarId: body.avatarId,
          requestedEngine: engine,
          supportedEngines: supported,
          hint:
            supported.length > 0
              ? `Try engine: "${supported[0]}" or pick a different avatar.`
              : "This avatar isn't API-accessible. Pick one from /api/avatars.",
        },
        { status: 400 }
      );
    }

    const voiceId = body.voiceId ?? look.default_voice_id ?? FALLBACK_VOICE_ID;
    stages.resolveVoice = {
      ms: Date.now() - t,
      result: {
        voiceId,
        source: body.voiceId
          ? "request"
          : look.default_voice_id
            ? "avatar_default"
            : "fallback",
        engine,
        avatar: look.name,
        avatarSupports: supported,
      },
    };

    // Stage 2: create video with script + voice. HeyGen synthesizes speech
    // internally — no separate /v3/voices/speech call.
    t = Date.now();
    const created = await createVideo({
      avatarId: body.avatarId,
      script: body.script,
      voiceId,
      engine,
      resolution: "1080p",
      aspectRatio: "16:9",
      title: `Test render @ ${new Date().toISOString()}`,
    });
    stages.createVideo = { ms: Date.now() - t, result: created };

    // Stage 3: poll until done
    t = Date.now();
    const interval = 10_000;
    const deadline = Date.now() + pollTimeoutMs;
    let lastStatus = created.status;
    let final = null;
    while (Date.now() < deadline) {
      const v = await getVideo(created.video_id);
      lastStatus = v.status;
      if (v.status === "completed" || v.status === "failed") {
        final = v;
        break;
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    stages.poll = {
      ms: Date.now() - t,
      result: { finalStatus: final?.status ?? `timed out (${lastStatus})` },
    };

    if (!final) {
      return NextResponse.json(
        {
          ok: false,
          stage: "poll",
          message: `Video did not finish within ${pollTimeoutMs}ms (last: ${lastStatus})`,
          videoId: created.video_id,
          stages,
          totalMs: Date.now() - startedAt,
        },
        { status: 504 }
      );
    }

    if (final.status === "failed") {
      return NextResponse.json(
        {
          ok: false,
          stage: "render",
          message: final.failure_message ?? "render failed",
          failureCode: final.failure_code,
          stages,
          totalMs: Date.now() - startedAt,
        },
        { status: 502 }
      );
    }

    // Stages 4 + 5: extract audio + transcribe (optional)
    let wordTimestamps: unknown = null;
    let transcript: string | null = null;
    if (!body.skipTranscription && final.video_url) {
      t = Date.now();
      const audio = await extractAudioFromVideoUrl(final.video_url);
      stages.extractAudio = {
        ms: Date.now() - t,
        result: { bytes: audio.buffer.byteLength },
      };

      t = Date.now();
      // Buffer → fresh Uint8Array → Blob. Node Buffer's backing is typed as
      // ArrayBufferLike (could be SharedArrayBuffer), which TS rejects for
      // BlobPart. Copying into a plain Uint8Array narrows the type cleanly.
      const audioBlob = new Blob([Uint8Array.from(audio.buffer)], {
        type: audio.contentType,
      });
      const transcription = await transcribeAudio({
        audio: audioBlob,
        filename: audio.filename,
        contentType: audio.contentType,
        timestampsGranularity: "word",
      });
      stages.transcribe = {
        ms: Date.now() - t,
        result: {
          language_code: transcription.language_code,
          wordCount: transcription.words.filter((w) => w.type === "word").length,
        },
      };
      transcript = transcription.text;
      wordTimestamps = transcription.words;
    }

    // Stage 6: auto-save MP4 + JSON metadata locally for review.
    // Disabled on Vercel (writable disk is /tmp only); enabled in dev.
    let savedPaths: { mp4?: string; json?: string } = {};
    if (process.env.VERCEL !== "1" && final.video_url) {
      try {
        savedPaths = await saveRenderLocally({
          videoUrl: final.video_url,
          videoId: created.video_id,
          metadata: {
            createdAt: new Date().toISOString(),
            avatarId: body.avatarId,
            voiceId,
            engine,
            script: body.script,
            videoId: created.video_id,
            videoUrl: final.video_url,
            duration: final.duration,
            transcript,
            wordTimestamps,
          },
        });
      } catch (e) {
        // Non-fatal — don't fail the response just because the local save broke
        savedPaths = { mp4: `save-error: ${(e as Error).message}` };
      }
    }

    return NextResponse.json({
      ok: true,
      stages,
      totalMs: Date.now() - startedAt,
      videoId: created.video_id,
      videoUrl: final.video_url,
      thumbnailUrl: final.thumbnail_url,
      duration: final.duration,
      voiceId,
      engine,
      transcript,
      wordTimestamps,
      savedPaths,
    });
  } catch (err) {
    if (err instanceof HeyGenError) {
      return NextResponse.json(
        {
          ok: false,
          source: "heygen",
          status: err.status,
          error: err.body,
          message: err.message,
          stages,
          totalMs: Date.now() - startedAt,
        },
        { status: err.status }
      );
    }
    if (err instanceof ElevenLabsError) {
      return NextResponse.json(
        {
          ok: false,
          source: "elevenlabs",
          status: err.status,
          error: err.body,
          message: err.message,
          stages,
          totalMs: Date.now() - startedAt,
        },
        { status: err.status }
      );
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { ok: false, message, stages, totalMs: Date.now() - startedAt },
      { status: 500 }
    );
  }
}
