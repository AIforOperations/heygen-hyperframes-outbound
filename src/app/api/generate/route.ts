import { runPipeline, type OrchestratorInput, type ProgressEvent } from "@/lib/orchestrator";
import { AnthropicError } from "@/lib/anthropic";
import { ApifyError } from "@/lib/apify";
import { SerpApiError } from "@/lib/serpapi";
import { HeyGenError } from "@/lib/heygen";
import { ElevenLabsError } from "@/lib/elevenlabs";

/**
 * POST /api/generate
 *
 * End-to-end pipeline: scrape → script → HeyGen → transcribe → compose → render.
 *
 * Two response modes (selected by Accept header):
 *   - text/event-stream  → SSE; one `event: progress` per stage transition,
 *                          final `event: result` with full payload, `event: error`
 *                          on failure. Use this from the frontend pipeline UI.
 *   - application/json   → blocking request, returns full result at the end.
 *                          Use this for cURL testing.
 *
 * Body:
 *   {
 *     input: { kind: "personUrl" | "companyUrl" | "companyName", value: string },
 *     offer: string,
 *     senderName: string,
 *     senderCompany?: string,           // default "LeadFlow"
 *     tonality?: string,
 *     scriptModel?: ClaudeModel,
 *     avatarId: string,
 *     engine?: "avatar_iv" | "avatar_v", // default "avatar_iv" to fit 300s
 *     voiceId?: string,
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
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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

  const wantsStream = req.headers.get("accept")?.includes("text/event-stream");

  if (wantsStream) {
    return streamResponse(validated);
  }
  return blockingResponse(validated);
}

// ----- JSON blocking mode -----

async function blockingResponse(input: OrchestratorInput): Promise<Response> {
  try {
    const result = await runPipeline(input);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const { status, body } = classifyError(err);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// ----- SSE streaming mode -----
//
// Each event is `event: <name>\ndata: <json>\n\n`. Frontend uses EventSource
// or fetch+ReadableStream to consume.

function sseLine(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function streamResponse(input: OrchestratorInput): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(sseLine(event, data)));
      };

      // Heartbeat so the connection doesn't get killed by intermediate proxies
      // (long HeyGen polls can be silent for ~10s otherwise).
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {
          /* controller may already be closed */
        }
      }, 15_000);

      const onProgress = (event: ProgressEvent) => {
        send("progress", event);
      };

      try {
        const result = await runPipeline(input, onProgress);
        send("result", result);
      } catch (err) {
        const { body } = classifyError(err);
        send("error", body);
      } finally {
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable Vercel's edge buffering for SSE
      "X-Accel-Buffering": "no",
    },
  });
}
