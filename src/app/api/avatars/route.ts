import { NextResponse } from "next/server";
import { getAvatarLook, HeyGenError } from "@/lib/heygen";
import { CURATED_AVATARS, type ResolvedAvatar } from "@/lib/avatars";

/**
 * GET /api/avatars
 *
 * Returns the curated 6 avatars (Ari + 5 public photo avatars) with fresh
 * preview URLs from HeyGen. Preview URLs from photo_avatar looks are
 * presigned and expire, so we fetch them on every request.
 *
 * Response order matches CURATED_AVATARS — Ari first.
 *
 * Cache headers: 5 minutes, since URLs are valid for at least that.
 */
export async function GET() {
  try {
    const resolved = await Promise.all(
      CURATED_AVATARS.map(async (curated): Promise<ResolvedAvatar> => {
        try {
          const look = await getAvatarLook(curated.id);
          return {
            ...curated,
            previewImageUrl: look.preview_image_url,
            previewVideoUrl: look.preview_video_url,
            heygenDefaultVoiceId: look.default_voice_id,
            supportedEngines:
              (look.supported_api_engines as ("avatar_v" | "avatar_iv")[]) ?? [],
          };
        } catch {
          // If a single avatar fails to fetch, fall back to the curated metadata
          // without a preview URL. The UI shows initials in that case.
          return {
            ...curated,
            previewImageUrl: null,
            previewVideoUrl: null,
            heygenDefaultVoiceId: null,
            supportedEngines: [],
          };
        }
      })
    );

    return NextResponse.json(
      { avatars: resolved },
      {
        headers: {
          "Cache-Control": "private, max-age=300, stale-while-revalidate=600",
        },
      }
    );
  } catch (err) {
    if (err instanceof HeyGenError) {
      return NextResponse.json(
        { error: err.message, status: err.status, details: err.body },
        { status: err.status }
      );
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
