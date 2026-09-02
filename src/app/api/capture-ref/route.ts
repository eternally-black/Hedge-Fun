import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import { captureReferral, accrueReferralForInvitee } from "@/lib/referral";
import { lookupReferralByDevice, deviceHashes } from "@/lib/refclick";
import { rateLimit } from "@/lib/ratelimit";
import type { CaptureRefResponse } from "@/lib/api-types";

// Referral capture WITHOUT marking the GM day. Sent on app open so attribution lands even if the
// user never taps GM. Mirrors the referral half of /api/login-mark (which keeps the GM half). The
// code comes from the hf_ref cookie (?ref=, stealth — never in the URL bar) or, if absent, the
// IP/UA device match logged when the /r/<code> link was clicked. captureReferral is idempotent
// (unique inviteeId), so this is safe to call on every open — only the first binds.
export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!rateLimit(`capture-ref:${user.id}`, 30, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  let refCode = new URL(req.url).searchParams.get("ref");
  if (!refCode) refCode = await lookupReferralByDevice(req.headers);

  let captured = false;
  if (refCode) {
    const inviter = await prisma.user.findUnique({ where: { referralCode: refCode } });
    if (inviter) {
      // Pass the invitee's current device fingerprint so captureReferral's self/device guard can
      // reject a same-device multi-account binding (null when no REFERRAL_HASH_SECRET — fail-safe).
      const r = await captureReferral(inviter.id, user.id, undefined, { inviteeDevice: deviceHashes(req.headers) });
      captured = r.referralId != null;
    }
  }

  // Pay the inviter's share of points the invitee has earned so far (idempotent, delta-only). Does
  // not depend on GM having run, so it's correct to trigger here at open.
  await accrueReferralForInvitee(user.id);

  const body: CaptureRefResponse = { captured };
  return NextResponse.json(body);
}
