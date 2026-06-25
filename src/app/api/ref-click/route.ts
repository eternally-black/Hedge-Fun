import { NextResponse } from "next/server";
import { logReferralClick } from "@/lib/refclick";

// Click-log endpoint, called from the BROWSER (page.tsx, on first load when an hf_ref cookie is
// present). Hashes the visitor's real IP+UA and logs the click for the cross-browser attribution
// fallback. Node runtime — Prisma can't run on the Edge. Best-effort: always 200 so a log failure
// never surfaces to the user. The browser's real IP (via x-forwarded-for from Caddy) + UA are what
// we hash, so the same device matches at signup time.
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
