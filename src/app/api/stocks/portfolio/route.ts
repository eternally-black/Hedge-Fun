import { NextResponse } from "next/server";
import { authUser } from "@/lib/privy";
import { rateLimit } from "@/lib/ratelimit";
import { portfolioFor, verifiedWallets } from "@/lib/stocks-db";
import { refreshWalletHoldings } from "@/lib/stocks-real";
import { HeliusUnavailableError } from "@/lib/helius";
import { prisma } from "@/lib/prisma";
import { STOCK_WALLET_RECONCILE_MAX_AGE_MS } from "@/lib/config";

// The user's stock portfolio: open + recent closed lots, both modes, priced from the STORED asset
// price (refreshed every poller tick; `fresh` false when older than the staleness bound). REAL lots
// are reconciled against the payer's live wallet balance first when their last check is older than
// STOCK_WALLET_RECONCILE_MAX_AGE_MS — a lot sold or moved in Phantom must not read as a holding. A
// Helius outage skips the reconciliation (the rows keep their last verdict) rather than failing the
// whole portfolio read.
// Adoption and reconciliation share one generation/slot-fenced wallet snapshot. Freshness is durable
// in StockWalletState, so multiple app instances do not fan out duplicate RPC reads.

export async function GET(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!rateLimit(`stocks-portfolio:${user.id}`, 60, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const now = new Date();
  const staleBefore = new Date(now.getTime() - STOCK_WALLET_RECONCILE_MAX_AGE_MS);
  for (const payer of await verifiedWallets(user.id)) {
    const state = await prisma.stockWalletState.findUnique({
      where: { userId_payer: { userId: user.id, payer } },
      select: { lastCheckedAt: true },
    });
    if (state?.lastCheckedAt && state.lastCheckedAt >= staleBefore) continue;
    try {
      await refreshWalletHoldings(user.id, payer, now);
    } catch (e) {
      if (!(e instanceof HeliusUnavailableError)) throw e;
    }
  }

  const body = await portfolioFor(user);
  return NextResponse.json(body);
}
