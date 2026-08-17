// POST /api/real/stake — set how much a single real swipe spends.
//
// Server-side rather than client state for the same reason realMode is: /api/real/intent takes the
// amount to spend from the user's ROW, never from the request body of a swipe. A client-only stake
// would mean the number that decides a debit is the number a stale tab happens to be holding.
//
// Deliberately NOT gated on consent: this only writes a preference, spends nothing, and a user who
// has stepped back to paper must still be able to set what their stake WILL be. Every route that
// actually moves money re-checks consent for itself.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import { isRealMoneyEligible, sameOrigin } from "@/lib/real";
import { REAL_MIN_STAKE_CENTS, REAL_MAX_STAKE_CENTS } from "@/lib/config";

export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isRealMoneyEligible(user)) return NextResponse.json({ error: "real_disabled" }, { status: 403 });
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const stakeCents = (raw as { stakeCents?: unknown })?.stakeCents;

  // Integer cents only. A float here would round somewhere downstream and debit a number the user
  // never chose; the bounds are the product floor and a fat-finger ceiling, not a policy limit.
  if (typeof stakeCents !== "number" || !Number.isInteger(stakeCents)) {
    return NextResponse.json({ error: "bad_stake" }, { status: 400 });
  }
  if (stakeCents < REAL_MIN_STAKE_CENTS || stakeCents > REAL_MAX_STAKE_CENTS) {
    return NextResponse.json(
      { error: "bad_stake", minCents: REAL_MIN_STAKE_CENTS, maxCents: REAL_MAX_STAKE_CENTS },
      { status: 400 },
    );
  }

  await prisma.user.update({ where: { id: user.id }, data: { realStakeCents: stakeCents } });
  return NextResponse.json({ ok: true, stakeCents });
}
