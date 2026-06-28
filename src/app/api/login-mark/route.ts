import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import { recordLogin } from "@/lib/login";
import { qualifyDay } from "@/lib/streak";
import { captureReferral, accrueReferralForInvitee } from "@/lib/referral";
import { lookupReferralByDevice, deviceHashes } from "@/lib/refclick";
import type { LoginMarkResponse } from "@/lib/api-types";

// The daily "GM" tap: login bonus + streak day qualification (one action in the MVP).
// On first ever call, captures a referral: code comes from the hf_ref cookie (stealth — never in
// the URL), or, if absent, from the IP/UA device match logged when the /r/<code> link was clicked.
export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Referral capture (once). ref = inviter's referralCode from the cookie; if the client sent
  // none (cookie purged / clicked in a different browser than they signed up in), fall back to
  // the IP/UA device match. captureReferral is idempotent (unique inviteeId), so this is safe to
  // run on every GM tap — only the first one binds.
  let refCode = new URL(req.url).searchParams.get("ref");
  if (!refCode) refCode = await lookupReferralByDevice(req.headers);
  if (refCode) {
    const inviter = await prisma.user.findUnique({ where: { referralCode: refCode } });
    // Pass the invitee's current device fingerprint so captureReferral's self/device guard can
    // reject a same-device multi-account binding (null when no REFERRAL_HASH_SECRET — fail-safe).
    if (inviter) await captureReferral(inviter.id, user.id, undefined, { inviteeDevice: deviceHashes(req.headers) });
  }

  const login = await recordLogin(user.id);
  const streak = await qualifyDay(user.id);

  // If this user was referred, pay their inviter's share of points earned so far
  // (idempotent, scans only un-accrued rows). Daily GM is the natural trigger.
  await accrueReferralForInvitee(user.id);

  const body: LoginMarkResponse = {
    login: { awarded: login.awarded, amount: login.amount },
    streak: { qualifiedToday: streak.qualifiedToday, level: streak.currentLevel, state: streak.state },
  };
  return NextResponse.json(body);
}
