import { NextResponse } from "next/server";
import {
  createVideo,
  generateSpeech,
  getVideo,
  HeyGenError,
  uploadAudioAsset,
} from "@/lib/heygen";

/**
 * POST /api/test/generate-video
 *
 * End-to-end HeyGen plumbing test. Runs the full 4-step flow synchronously:
 *   1. Generate speech (Starfish engine → word timestamps)
 *   2. Upload audio to /v3/assets → stable asset_id
 *   3. Create video with engine.type = avatar_v + audio_asset_id
 *   4. Poll until completed
 *
 * Request body (JSON):
 *   {
 *     avatarId: string         // required
 *     script: string           // required, 1-5000 chars
 *     voiceId?: string         // optional, defaults to Aria (English Starfish)
 *     engine?: "avatar_v" | "avatar_iv"  // optional, defaults to avatar_v
 *     pollTimeoutMs?: number   // optional, defaults to 15 min
 *   }
 *
 * Response: stage-by-stage timing + final video_url + word_timestamps.
 *
 * NOTE: Vercel functions cap at 60s (Hobby) / 800s (Pro). HeyGen renders take
 * 3-7 min — this route will TIME OUT in production. It's a local-dev smoke test
 * only. Production will use webhooks instead of polling.
 *
 * Configure this route to run for up to 5 min locally:
 */
export const maxDuration = 300;

const DEFAULT_VOICE_ID = "007e1378fc454a9f976db570ba6164a7"; // Aria — English, female, Starfish

interface RequestBody {
  avatarId: string;
  script: string;
  voiceId?: string;
  engine?: "avatar_v" | "avatar_iv";
  pollTimeoutMs?: number;
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

    const voiceId = body.voiceId ?? DEFAULT_VOICE_ID;
    const engine = body.engine ?? "avatar_v";
    const pollTimeoutMs = body.pollTimeoutMs ?? 5 * 60 * 1000;

    // Stage 1: speech
    let t = Date.now();
    const speech = await generateSpeech({
      text: body.script,
      voiceId,
    });
    stages.speech = {
      ms: Date.now() - t,
      result: {
        duration: speech.duration,
        wordCount: speech.word_timestamps?.length ?? 0,
        audioUrl: speech.audio_url,
        firstWords: speech.word_timestamps?.slice(0, 5),
      },
    };

    // Stage 2: upload audio as durable asset
    t = Date.now();
    const asset = await uploadAudioAsset(speech.audio_url);
    stages.uploadAsset = { ms: Date.now() - t, result: asset };

    // Stage 3: create video
    t = Date.now();
    const created = await createVideo({
      avatarId: body.avatarId,
      audioAssetId: asset.asset_id,
      engine,
      resolution: "1080p",
      aspectRatio: "16:9",
      title: `Test render @ ${new Date().toISOString()}`,
    });
    stages.createVideo = { ms: Date.now() - t, result: created };

    // Stage 4: poll until done
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
          message: `Video did not finish within ${pollTimeoutMs}ms (last status: ${lastStatus})`,
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

    return NextResponse.json({
      ok: true,
      stages,
      totalMs: Date.now() - startedAt,
      videoId: created.video_id,
      videoUrl: final.video_url,
      thumbnailUrl: final.thumbnail_url,
      duration: final.duration,
      wordTimestamps: speech.word_timestamps,
    });
  } catch (err) {
    if (err instanceof HeyGenError) {
      return NextResponse.json(
        {
          ok: false,
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
