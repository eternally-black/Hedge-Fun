import { NextResponse } from "next/server";
import { logReferralClick } from "@/lib/refclick";

// Internal endpoint the middleware fire-and-forgets to. Hashes the visitor's IP+UA and logs the
// click (Node runtime — Prisma can't run in the Edge middleware). Best-effort: always 200 so a
// log failure never bubbles anywhere; the user already got redirected by the middleware.
//
// The middleware forwards the real client headers (x-forwarded-for / user-agent / accept-language),
// so we hash the visitor, not the edge node that called us.
export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const { code } = (await req.json()) as { code?: string };
    if (code) await logReferralClick(code, req.headers);
  } catch {
    /* swallow — click logging is best-effort, never fails the request */
  }
  return NextResponse.json({ ok: true });
}
