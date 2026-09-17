import { NextResponse } from "next/server";
import { authUser } from "@/lib/privy";
import { rateLimit } from "@/lib/ratelimit";
import { portfolioFor, verifiedWallets } from "@/lib/stocks-db";
import { adoptWalletHoldings, reconcileRealLots } from "@/lib/stocks-real";
import { HeliusUnavailableError } from "@/lib/helius";
import { prisma } from "@/lib/prisma";
import { STOCK_WALLET_RECONCILE_MAX_AGE_MS } from "@/lib/config";

// The user's stock portfolio: open + recent closed lots, both modes, priced from the STORED asset
// price (refreshed every poller tick; `fresh` false when older than the staleness bound). REAL lots
// are reconciled against the payer's live wallet balance first when their last check is older than
// STOCK_WALLET_RECONCILE_MAX_AGE_MS — a lot sold or moved in Phantom must not read as a holding. A
// Helius outage skips the reconciliation (the rows keep their last verdict) rather than failing the
// whole portfolio read.
// Every verified wallet is read for xStocks we never booked (adoptWalletHoldings) — what a user who
// connects a wallet full of them expects to see. At most once a minute per wallet: the Portfolio
// polls every few seconds while visible, and two RPC reads per poll would pay for a number that only
// moves when the user trades elsewhere. ponytail: in-memory, per process; a column if a second app
// instance ever appears.
const ADOPT_EVERY_MS = 60_000;
const adoptedAt = new Map<string, number>();

export async function GET(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!rateLimit(`stocks-portfolio:${user.id}`, 60, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  for (const payer of await verifiedWallets(user.id)) {
    const key = `${user.id}:${payer}`;
    if (Date.now() - (adoptedAt.get(key) ?? 0) < ADOPT_EVERY_MS) continue;
    adoptedAt.set(key, Date.now());
    try {
      await adoptWalletHoldings(user.id, payer);
    } catch (e) {
      adoptedAt.delete(key); // a failed read is retried on the next poll
      if (!(e instanceof HeliusUnavailableError)) throw e;
    }
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

  const body = await portfolioFor(user);
  return NextResponse.json(body);
}
