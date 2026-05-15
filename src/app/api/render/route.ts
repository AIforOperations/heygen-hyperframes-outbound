import { NextResponse } from "next/server";
import path from "node:path";
import { put } from "@vercel/blob";
import { collectCompositionFiles } from "@/lib/composition-files";
import { renderInSandbox } from "@/lib/sandbox";

/**
 * POST /api/render
 *
 * Body (optional):
 *   { compositionDir?: string }   // relative to project root; default "public/compositions/demo-01"
 *
 * Flow:
 *   1. Collect composition files from disk
 *   2. Render in a Vercel Sandbox (snapshot or fresh setup)
 *   3. Upload the resulting MP4 to Vercel Blob
 *   4. Return the public URL
 */

export const runtime = "nodejs";
// Hobby plan caps Serverless Functions at 300s. A warm sandbox render fits
// (~150s total). Cold-start renders without a cached snapshot will time out —
// the snapshot is built at deploy time to avoid that.
export const maxDuration = 800;

interface RenderRequest {
  compositionDir?: string;
}

export async function POST(req: Request) {
  const startedAt = Date.now();

  try {
    let body: Partial<RenderRequest> = {};
    try {
      body = (await req.json()) as Partial<RenderRequest>;
    } catch {
      // empty body is fine — fall back to default composition
    }

    const compositionRel = body.compositionDir ?? "public/compositions/demo-01";
    const compositionAbs = path.resolve(process.cwd(), compositionRel);

    // Stage 1: read composition off disk
    const collectStart = Date.now();
    const files = await collectCompositionFiles(compositionAbs);
    if (files.length === 0) {
      return NextResponse.json(
        { error: `No files found at ${compositionRel}` },
        { status: 400 }
      );
    }
    const collectMs = Date.now() - collectStart;

    // Stage 2: render in sandbox
    const result = await renderInSandbox(files);

    // Stage 3: upload to Blob
    const uploadStart = Date.now();
    const blob = await put(
      `renders/${new Date().toISOString().replace(/[:.]/g, "-")}.mp4`,
      result.mp4,
      {
        access: "public",
        contentType: "video/mp4",
        addRandomSuffix: true,
        allowOverwrite: false,
      }
    );
    const uploadMs = Date.now() - uploadStart;

    return NextResponse.json({
      ok: true,
      url: blob.url,
      bytes: result.mp4.byteLength,
      fromSnapshot: result.fromSnapshot,
      stages: {
        collectFiles: { ms: collectMs, fileCount: files.length },
        sandbox: {
          ms: result.totalMs,
          setupMs: result.setupMs,
          renderMs: result.renderMs,
        },
        uploadBlob: { ms: uploadMs },
      },
      totalMs: Date.now() - startedAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { ok: false, message, totalMs: Date.now() - startedAt },
      { status: 500 }
    );
  }
}
