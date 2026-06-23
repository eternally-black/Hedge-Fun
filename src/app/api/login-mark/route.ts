import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import { recordLogin } from "@/lib/login";
import { qualifyDay } from "@/lib/streak";
import { captureReferral, accrueReferralForInvitee } from "@/lib/referral";

// The daily "GM" tap: login bonus + streak day qualification (one action in the MVP).
// On first ever call, captures a referral if a ?ref=<referralCode> is present.
export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Referral capture (once). ref = inviter's referralCode.
  const refCode = new URL(req.url).searchParams.get("ref");
  if (refCode) {
    const inviter = await prisma.user.findUnique({ where: { referralCode: refCode } });
    if (inviter) await captureReferral(inviter.id, user.id);
  }

  const login = await recordLogin(user.id);
  const streak = await qualifyDay(user.id);

  // If this user was referred, pay their inviter's share of points earned so far
  // (idempotent, scans only un-accrued rows). Daily GM is the natural trigger.
  await accrueReferralForInvitee(user.id);

  return NextResponse.json({
    login: { awarded: login.awarded, amount: login.amount },
    streak: { qualifiedToday: streak.qualifiedToday, level: streak.currentLevel, state: streak.state },
  });
}
