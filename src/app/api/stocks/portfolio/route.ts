import { NextResponse } from "next/server";
import { authUser } from "@/lib/privy";
import { rateLimit } from "@/lib/ratelimit";
import { portfolioFor } from "@/lib/stocks-db";
import { reconcileRealLots } from "@/lib/stocks-real";
import { HeliusUnavailableError } from "@/lib/helius";
import { prisma } from "@/lib/prisma";
import { STOCK_WALLET_RECONCILE_MAX_AGE_MS } from "@/lib/config";

// The user's stock portfolio: open + recent closed lots, both modes, priced from the STORED asset
// price (refreshed every poller tick; `fresh` false when older than the staleness bound). REAL lots
// are reconciled against the payer's live wallet balance first when their last check is older than
// STOCK_WALLET_RECONCILE_MAX_AGE_MS — a lot sold or moved in Phantom must not read as a holding. A
// Helius outage skips the reconciliation (the rows keep their last verdict) rather than failing the
// whole portfolio read.
export async function GET(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!rateLimit(`stocks-portfolio:${user.id}`, 60, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const staleBefore = new Date(Date.now() - STOCK_WALLET_RECONCILE_MAX_AGE_MS);
  const stale = await prisma.stockPosition.findMany({
    where: {
      userId: user.id,
      mode: "REAL",
      closedAt: null,
      payer: { not: null },
      OR: [{ walletCheckedAt: null }, { walletCheckedAt: { lt: staleBefore } }],
    },
    distinct: ["payer"],
    select: { payer: true },
  });
  for (const { payer } of stale) {
    if (!payer) continue;
    try {
      await reconcileRealLots(user.id, payer);
    } catch (e) {
      if (!(e instanceof HeliusUnavailableError)) throw e;
    }
  }

  const body = await portfolioFor(user.id);
  return NextResponse.json(body);
}
