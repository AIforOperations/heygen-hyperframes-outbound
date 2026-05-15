import { NextResponse } from "next/server";
import {
  startPipelineAsync,
  progressPipelineAsync,
  type OrchestratorInput,
} from "@/lib/orchestrator";
import { readJob } from "@/lib/jobs";
import { AnthropicError } from "@/lib/anthropic";
import { ApifyError } from "@/lib/apify";
import { SerpApiError } from "@/lib/serpapi";
import { HeyGenError } from "@/lib/heygen";
import { ElevenLabsError } from "@/lib/elevenlabs";

/**
 * POST /api/generate     → start pipeline (scrape + script + heygen kickoff)
 *                          returns: { jobId, state }
 *
 * GET  /api/generate?jobId=X  → advance + read state; runs post-HeyGen stages
 *                          inline when HeyGen completes. Frontend polls this
 *                          every 5-10s.
 *
 * Body for POST:
 *   {
 *     input: { kind, value },
 *     offer: string,
 *     senderName: string,        // avatar's label
 *     senderCompany?: string,    // default "LeadFlow"
 *     tonality?: string,
 *     avatarId: string,
 *     engine?: "avatar_v" | "avatar_iv",   // default "avatar_v"
 *     voiceId?: string,
 *     lengthSeconds?: number,    // default 30
 *   }
 */
export const runtime = "nodejs";
export const maxDuration = 300;

interface RequestBody {
  input?: OrchestratorInput["input"];
  offer?: string;
  senderName?: string;
  senderCompany?: string;
  tonality?: string;
  scriptModel?: OrchestratorInput["scriptModel"];
  lengthSeconds?: number;
  avatarId?: string;
  engine?: OrchestratorInput["engine"];
  voiceId?: string;
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

function classifyError(err: unknown): { status: number; body: Record<string, unknown> } {
  if (err instanceof ApifyError) {
    return {
      status: err.status >= 400 ? err.status : 502,
      body: { ok: false, source: "apify", actorId: err.actorId, message: err.message },
    };
  }
  if (err instanceof SerpApiError) {
    return {
      status: err.status >= 400 ? err.status : 502,
      body: { ok: false, source: "serpapi", message: err.message },
    };
  }
  if (err instanceof AnthropicError) {
    return {
      status: err.status >= 400 ? err.status : 502,
      body: { ok: false, source: "anthropic", message: err.message },
    };
  }
  if (err instanceof HeyGenError) {
    return {
      status: err.status >= 400 ? err.status : 502,
      body: { ok: false, source: "heygen", message: err.message },
    };
  }
  if (err instanceof ElevenLabsError) {
    return {
      status: err.status >= 400 ? err.status : 502,
      body: { ok: false, source: "elevenlabs", message: err.message },
    };
  }
  const message = err instanceof Error ? err.message : "Unknown error";
  return { status: 500, body: { ok: false, message } };
}

function validate(body: RequestBody): OrchestratorInput | string {
  if (!body.input || typeof body.input !== "object") {
    return "input is required ({ kind, value })";
  }
  const { kind, value } = body.input as { kind?: string; value?: string };
  if (!kind || !value) return "input.kind and input.value are required";
  if (!["personUrl", "companyUrl", "companyName"].includes(kind)) {
    return `input.kind must be personUrl | companyUrl | companyName (got "${kind}")`;
  }
  if (!body.offer || !body.offer.trim()) return "offer is required";
  if (!body.senderName || !body.senderName.trim()) {
    return "senderName is required (the avatar's display name)";
  }
  if (!body.avatarId || !body.avatarId.trim()) return "avatarId is required";

  return {
    input: { kind, value } as OrchestratorInput["input"],
    offer: body.offer,
    senderName: body.senderName,
    senderCompany: body.senderCompany,
    tonality: body.tonality,
    scriptModel: body.scriptModel,
    lengthSeconds: body.lengthSeconds,
    avatarId: body.avatarId,
    engine: body.engine,
    voiceId: body.voiceId,
  };
}

export async function POST(req: Request) {
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const validated = validate(body);
  if (typeof validated === "string") {
    return jsonError(validated, 400);
  }

  try {
    const job = await startPipelineAsync(validated);
    if (job.status === "failed") {
      // Pipeline kickoff errored synchronously (scrape/script/heygen-create).
      return NextResponse.json({ ok: false, jobId: job.jobId, state: job }, { status: 502 });
    }
    return NextResponse.json({ ok: true, jobId: job.jobId, state: job });
  } catch (err) {
    const { status, body: errBody } = classifyError(err);
    return NextResponse.json(errBody, { status });
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const jobId = url.searchParams.get("jobId");
  if (!jobId) return jsonError("jobId query parameter is required", 400);

  try {
    // If the job is already complete, just read it. Otherwise advance one tick.
    const existing = await readJob(jobId);
    if (!existing) return jsonError(`Job ${jobId} not found`, 404);
    if (existing.status === "complete" || existing.status === "failed") {
      return NextResponse.json({ ok: true, state: existing });
    }
    const state = await progressPipelineAsync(jobId);
    if (!state) return jsonError(`Job ${jobId} not found`, 404);
    return NextResponse.json({ ok: true, state });
  } catch (err) {
    const { status, body: errBody } = classifyError(err);
    return NextResponse.json(errBody, { status });
  }
}
