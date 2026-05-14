import { NextResponse } from "next/server";
import { HeyGenError, listAvatarLooks, listVoices } from "@/lib/heygen";

/**
 * GET /api/heygen/ping
 *
 * Smoke test for the HeyGen API key. Lists Avatar V-eligible avatars and
 * Starfish voices (the ones that return word_timestamps).
 *
 * Usage:
 *   curl http://localhost:3030/api/heygen/ping | jq
 */
export async function GET() {
  try {
    const [looks, voices] = await Promise.all([
      listAvatarLooks({ limit: 50 }),
      listVoices({ engine: "starfish", limit: 50 }),
    ]);

    const avatarVLooks = looks.data.filter((l) =>
      l.supported_api_engines?.includes("avatar_v")
    );

    return NextResponse.json({
      ok: true,
      counts: {
        total_looks: looks.data.length,
        avatar_v_eligible: avatarVLooks.length,
        starfish_voices: voices.data.length,
      },
      avatar_v_sample: avatarVLooks.slice(0, 5).map((l) => ({
        id: l.id,
        name: l.name,
        avatar_type: l.avatar_type,
        default_voice_id: l.default_voice_id,
        preview_image_url: l.preview_image_url,
      })),
      starfish_voice_sample: voices.data.slice(0, 5).map((v) => ({
        voice_id: v.voice_id,
        name: v.name,
        language: v.language,
        gender: v.gender,
      })),
    });
  } catch (err) {
    if (err instanceof HeyGenError) {
      return NextResponse.json(
        { ok: false, status: err.status, error: err.body, message: err.message },
        { status: err.status }
      );
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}
