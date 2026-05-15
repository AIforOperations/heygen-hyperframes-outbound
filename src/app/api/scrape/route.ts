import { NextResponse } from "next/server";
import { scrapeLead } from "@/lib/scrape";
import { ApifyError } from "@/lib/apify";
import { SerpApiError } from "@/lib/serpapi";
import type { ScrapeInput } from "@/lib/resolve";

/**
 * POST /api/scrape
 *
 * Body: { kind: "personUrl" | "companyUrl" | "companyName", value: string }
 *
 * Returns a normalized Lead — feed straight into the (forthcoming) script-gen
 * step. Stages timing is included so the frontend can stream progress updates.
 */
export const maxDuration = 60;

const VALID_KINDS = new Set(["personUrl", "companyUrl", "companyName"]);

interface RequestBody {
  kind?: string;
  value?: string;
}

export async function POST(req: Request) {
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.kind || !VALID_KINDS.has(body.kind)) {
    return NextResponse.json(
      { error: `kind must be one of: ${[...VALID_KINDS].join(", ")}` },
      { status: 400 }
    );
  }
  if (!body.value || typeof body.value !== "string" || !body.value.trim()) {
    return NextResponse.json({ error: "value is required" }, { status: 400 });
  }

  const input = { kind: body.kind, value: body.value.trim() } as ScrapeInput;

  try {
    const result = await scrapeLead(input);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof ApifyError) {
      return NextResponse.json(
        {
          ok: false,
          source: "apify",
          actorId: err.actorId,
          status: err.status,
          message: err.message,
          error: err.body,
        },
        { status: err.status >= 400 ? err.status : 502 }
      );
    }
    if (err instanceof SerpApiError) {
      return NextResponse.json(
        {
          ok: false,
          source: "serpapi",
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
