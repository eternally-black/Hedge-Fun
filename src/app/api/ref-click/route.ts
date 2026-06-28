import { NextResponse } from "next/server";
import { logReferralClick, clientIp } from "@/lib/refclick";
import { rateLimit } from "@/lib/ratelimit";

// Click-log endpoint, called from the BROWSER (page.tsx, on first load when an hf_ref cookie is
// present). Hashes the visitor's real IP+UA and logs the click for the cross-browser attribution
// fallback. Node runtime — Prisma can't run on the Edge. Best-effort: always 200 so a log failure
// never surfaces to the user. The browser's real IP (via x-forwarded-for from Caddy) + UA are what
// we hash, so the same device matches at signup time.
export const runtime = "nodejs";

// Same shape middleware.ts accepts (4-char no-look-alike alphabet, tolerant 3..8). Replicated, not
// imported: middleware runs on the Edge and shouldn't be pulled into a Node route's bundle.
const CODE_RE = /^[A-HJ-NP-Z2-9]{3,8}$/i;
const MAX_CODE_LEN = 8; // short-circuit oversized junk before the regex / DB (CODE_RE caps it too)

export async function POST(req: Request) {
  try {
    const { code } = (await req.json()) as { code?: string };
    // This endpoint is unauthenticated and writes a DB row per call. Validate + rate-limit BEFORE
    // persisting so a malformed/oversized/spammed click can't inflate referral_clicks. Still 200
    // always (best-effort), we just skip the write.
    if (!code || code.length > MAX_CODE_LEN || !CODE_RE.test(code)) return NextResponse.json({ ok: true });
    // Bound writes per visitor IP (real client IP via x-forwarded-for). 20 logged clicks / minute
    // is far above any legitimate first-load burst, well below a spam loop.
    if (!rateLimit(`ref-click:${clientIp(req.headers)}`, 20, 60_000)) return NextResponse.json({ ok: true });
    await logReferralClick(code, req.headers);
  } catch {
    /* swallow — click logging is best-effort, never fails the request */
  }
  return NextResponse.json({ ok: true });
}
