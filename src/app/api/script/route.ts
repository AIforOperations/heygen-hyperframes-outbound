import { NextResponse } from "next/server";
import { generateScript, type ScriptInput } from "@/lib/script";
import { AnthropicError } from "@/lib/anthropic";
import type { Lead } from "@/lib/scrape";

/**
 * POST /api/script
 *
 * Body:
 *   {
 *     lead: Lead,                    // required — output of /api/scrape
 *     offer: string,                 // required — what the sender pitches
 *     senderName: string,            // required — the avatar's display name
 *     senderCompany?: string,        // default: "LeadFlow"
 *     tonality?: "vt_analyst" | "vt_founder" | "vt_closer" | "vt_advisor"
 *               | <custom voice description string>,
 *     model?: "claude-opus-4-7" | "claude-sonnet-4-6" | "claude-haiku-4-5-20251001"
 *   }
 *
 * Returns: { ok, script, wordCount, estimatedSeconds, model, usage }
 */
export const maxDuration = 60;

interface RequestBody {
  lead?: Lead;
  offer?: string;
  senderName?: string;
  senderCompany?: string;
  tonality?: string;
  model?: ScriptInput["model"];
}

export async function POST(req: Request) {
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.lead || typeof body.lead !== "object") {
    return NextResponse.json(
      { error: "lead is required (object — output of /api/scrape)" },
      { status: 400 }
    );
  }
  if (!body.offer || typeof body.offer !== "string" || !body.offer.trim()) {
    return NextResponse.json(
      { error: "offer is required (string — what you're pitching)" },
      { status: 400 }
    );
  }
  if (!body.senderName || typeof body.senderName !== "string" || !body.senderName.trim()) {
    return NextResponse.json(
      { error: "senderName is required (string — the avatar's display name)" },
      { status: 400 }
    );
  }

  try {
    const result = await generateScript({
      lead: body.lead,
      offer: body.offer,
      senderName: body.senderName,
      senderCompany: body.senderCompany,
      tonality: body.tonality,
      model: body.model,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof AnthropicError) {
      return NextResponse.json(
        {
          ok: false,
          source: "anthropic",
          status: err.status,
          message: err.message,
          error: err.body,
        },
        { status: err.status >= 400 ? err.status : 502 }
      );
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}
