import { NextResponse } from "next/server";
import {
  addWaitlistEntry,
  isValidEmail,
  listWaitlistEntries,
  waitlistCount,
} from "@/lib/waitlist";

/**
 * POST /api/waitlist            → public; body { email } → 200 / 400 / 500
 * GET  /api/waitlist            → admin-only; requires X-Admin-Secret
 *                                  matching env.ADMIN_SECRET. Returns the
 *                                  most recent signups (newest first).
 *
 * GET is gated behind a server-only secret so the waitlist isn't a public
 * email list anyone can scrape. When ADMIN_SECRET isn't set in env, GET
 * is disabled entirely.
 */

export const runtime = "nodejs";
export const maxDuration = 30;

interface PostBody {
  email?: unknown;
}

export async function POST(req: Request) {
  let body: PostBody = {};
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const rawEmail = typeof body.email === "string" ? body.email : "";
  if (!isValidEmail(rawEmail)) {
    return NextResponse.json(
      { ok: false, error: "Enter a valid email." },
      { status: 400 }
    );
  }

  try {
    const result = await addWaitlistEntry(rawEmail, {
      userAgent: req.headers.get("user-agent"),
      referer: req.headers.get("referer"),
    });
    // Log so signups appear in Vercel function logs without needing the
    // admin GET endpoint. Visible to the project owner; not a privacy
    // issue since the email was submitted by the user themselves.
    console.log(
      `[waitlist] ${result.isNew ? "new" : "repeat"} signup: ${rawEmail
        .trim()
        .toLowerCase()} (total=${result.total})`
    );
    return NextResponse.json({
      ok: true,
      isNew: result.isNew,
      total: result.total,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to store signup";
    console.error(`[waitlist] storage failed: ${message}`);
    return NextResponse.json(
      { ok: false, error: "Couldn't save your email — try again in a moment." },
      { status: 500 }
    );
  }
}

export async function GET(req: Request) {
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "GET disabled. Set ADMIN_SECRET in Vercel env to enable inspection.",
      },
      { status: 403 }
    );
  }
  const provided = req.headers.get("x-admin-secret");
  if (provided !== adminSecret) {
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const limitParam = parseInt(url.searchParams.get("limit") ?? "100", 10);
  const limit = Math.min(
    500,
    Math.max(1, Number.isFinite(limitParam) ? limitParam : 100)
  );

  try {
    const [entries, total] = await Promise.all([
      listWaitlistEntries(limit),
      waitlistCount(),
    ]);
    return NextResponse.json({ ok: true, total, entries });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to read waitlist";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
