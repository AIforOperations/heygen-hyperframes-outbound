import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { buildCompositionV2 } from "@/lib/composition-v2";
import { renderInSandbox } from "@/lib/sandbox";
import type { Lead } from "@/lib/scrape";

/**
 * POST /api/test/v2-smoke
 *
 * Hackathon-only smoke test for the Claude planner + scene compiler + render.
 * Skips the HeyGen render — feeds an existing HeyGen MP4 URL straight into
 * the post-heygen pipeline (transcribe-equivalent assumed already done; we
 * only need an avatar MP4 and a Lead).
 *
 * Body:
 *   {
 *     heygenVideoUrl: string,
 *     duration: number,
 *     avatarId: string,
 *     lead: Lead,
 *     senderName: string,
 *     senderCompany: string,
 *     scriptText: string,
 *     offer: string
 *   }
 */
export const runtime = "nodejs";
export const maxDuration = 800;

export async function POST(req: Request) {
  const startedAt = Date.now();
  const stages: Record<string, number> = {};

  try {
    const body = (await req.json()) as {
      heygenVideoUrl?: string;
      duration?: number;
      avatarId?: string;
      lead?: Lead;
      senderName?: string;
      senderCompany?: string;
      scriptText?: string;
      offer?: string;
    };

    if (!body.heygenVideoUrl || !body.duration || !body.avatarId || !body.lead) {
      return NextResponse.json(
        { ok: false, error: "missing required fields" },
        { status: 400 }
      );
    }

    // 1. Download the avatar MP4
    let t = Date.now();
    const r = await fetch(body.heygenVideoUrl);
    if (!r.ok) {
      return NextResponse.json(
        { ok: false, error: `download failed: ${r.status}` },
        { status: 502 }
      );
    }
    const mp4 = Buffer.from(await r.arrayBuffer());
    stages.download = Date.now() - t;

    // 2. Compose (Claude plan → compiler → SandboxFile[])
    t = Date.now();
    const files = await buildCompositionV2({
      jobId: `v2-smoke-${Date.now().toString(36)}`,
      mp4,
      duration: body.duration,
      avatarId: body.avatarId,
      lead: body.lead,
      senderName: body.senderName ?? "Ari",
      senderCompany: body.senderCompany ?? "LeadFlow",
      scriptText: body.scriptText,
      offer: body.offer,
    });
    stages.compose = Date.now() - t;

    // 3. Render via Vercel Sandbox
    t = Date.now();
    const render = await renderInSandbox(files);
    stages.render = Date.now() - t;

    // 4. Upload final MP4 to Blob
    t = Date.now();
    const blob = await put(
      `renders/v2-smoke-${new Date().toISOString().replace(/[:.]/g, "-")}.mp4`,
      render.mp4,
      {
        access: "public",
        contentType: "video/mp4",
        addRandomSuffix: true,
        allowOverwrite: false,
      }
    );
    stages.upload = Date.now() - t;

    return NextResponse.json({
      ok: true,
      outputUrl: blob.url,
      bytes: render.mp4.byteLength,
      fromSnapshot: render.fromSnapshot,
      stages,
      fileCount: files.length,
      totalMs: Date.now() - startedAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    // Surface the compiler's ValidationError details (validatePlan errors).
    const details = (err as { details?: unknown })?.details ?? null;
    return NextResponse.json(
      { ok: false, error: message, details, stages, totalMs: Date.now() - startedAt },
      { status: 500 }
    );
  }
}
