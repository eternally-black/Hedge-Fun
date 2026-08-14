// POST /api/real/intent — phase 1 of the two-phase order protocol (plan §2.1): the server derives
// EXACT order params from a fresh fee-inclusive quote and persists a durable OrderAttempt BEFORE
// anything is signed. The client signs exactly these params; submit validates the signed order
// against THIS row. One in-flight attempt per (user, market) — DB partial unique, not app logic.
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import { isRealMoneyEligible, hasRealConsent } from "@/lib/real";
import { captureToGlitchTip } from "@/lib/glitchtip";
import { getMarketFee } from "@/lib/fees";
import { getBook } from "@/lib/clob";
import { quoteBuyAllIn } from "@/lib/quote";
import { STAKE_CENTS, HEDGE_MIN_STAKE_CENTS, HEDGE_MAX_STAKE_CENTS, SWIPE_CAP, DECK_MIN_LEAD_MS } from "@/lib/config";

export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isRealMoneyEligible(user)) return NextResponse.json({ error: "real_disabled" }, { status: 403 });
  if (!hasRealConsent(user)) return NextResponse.json({ error: "consent_required" }, { status: 403 });
  if (!user.depositWalletAddress || !user.embeddedWalletAddress) {
    return NextResponse.json({ error: "no_deposit_wallet" }, { status: 409 });
  }

  let marketId: unknown, side: unknown, stakeCents: unknown, geo: unknown;
  try {
    ({ marketId, side, stakeCents, geo } = await req.json());
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  if (typeof marketId !== "string" || (side !== "YES" && side !== "NO")) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const stake = typeof stakeCents === "number" && Number.isInteger(stakeCents) ? stakeCents : STAKE_CENTS;
  if (stake < HEDGE_MIN_STAKE_CENTS || stake > HEDGE_MAX_STAKE_CENTS) {
    return NextResponse.json({ error: "bad_stake" }, { status: 400 });
  }

  // Geo (plan §2.7): the browser-reported verdict is REQUIRED for ENTRY and recorded on the
  // attempt. It is policy, not proof — Polymarket's own IP rejection is the real barrier.
  const g = geo as { blocked?: boolean; country?: string; closedOnly?: boolean } | undefined;
  if (!g || typeof g.blocked !== "boolean") return NextResponse.json({ error: "geo_required" }, { status: 400 });
  if (g.blocked || g.closedOnly) return NextResponse.json({ error: "geo_blocked" }, { status: 403 });

  // Q1: real swipes consume the DECK cap — enforce at intent time (booking re-checks at fill).
  const utcDay = new Date().toISOString().slice(0, 10);
  const counter = await prisma.dailyCounter.findUnique({ where: { userId_utcDay: { userId: user.id, utcDay } } });
  if ((counter?.swipeCount ?? 0) >= SWIPE_CAP) {
    return NextResponse.json({ error: "daily swipe limit reached" }, { status: 403 });
  }

  const market = await prisma.market.findUnique({ where: { id: marketId } });
  if (!market || market.source !== "POLYMARKET" || market.status !== "OPEN") {
    return NextResponse.json({ error: "market_unavailable" }, { status: 409 });
  }
  if (market.resolutionDeadline.getTime() < Date.now() + DECK_MIN_LEAD_MS) {
    return NextResponse.json({ error: "market_closing" }, { status: 409 });
  }
  const tokenId = side === "YES" ? market.yesTokenId : market.noTokenId;
  if (!tokenId) return NextResponse.json({ error: "market_unavailable" }, { status: 409 });

  // Fee + neg-risk (fail-closed: unknown = excluded — the third approval is deliberately unset).
  const fee = await getMarketFee(prisma, market);
  if (fee.negRisk !== false) return NextResponse.json({ error: "neg_risk_excluded" }, { status: 409 });

  const book = await getBook(tokenId).catch(() => null);
  if (!book) return NextResponse.json({ error: "book_unavailable" }, { status: 503 });
  // Belt over the fee-cache flag (K3 F2): the raw book's own per-token neg_risk wins when it
  // disagrees or the cache came from an absent-field default. true OR unknown-on-both = excluded.
  if (book.negRisk !== false) {
    return NextResponse.json({ error: "neg_risk_excluded" }, { status: 409 });
  }

  const budgetMicro = BigInt(stake) * 10_000n; // cents → micro-USD
  const q = quoteBuyAllIn(book.asks, budgetMicro, fee.rateBp, fee.expMilli);
  if (!q) return NextResponse.json({ error: "no_liquidity" }, { status: 409 });

  // minOrderSize is SHARES (trap list); reject before anyone signs an unfillable order.
  if (q.sharesMicro < BigInt(Math.round(book.minOrderSize * 1_000_000))) {
    return NextResponse.json({ error: "stake_too_small", minShares: book.minOrderSize }, { status: 409 });
  }

  // maxPrice = MARGINAL ask (never VWAP), tick-rounded UP for a BUY (rounding down makes the
  // protection unfillable — trap list), clamped inside [tick, 1-tick].
  const tickBp = Math.round(book.tickSize * 10_000);
  if (tickBp <= 0) return NextResponse.json({ error: "book_unavailable" }, { status: 503 });
  const maxPriceBp = Math.min(Math.ceil(q.marginalAskBp / tickBp) * tickBp, 10_000 - tickBp);

  const approvedParams = {
    side: "BUY",
    tokenId,
    betSide: side,
    stakeCents: stake,
    allInCapMicro: budgetMicro.toString(),
    sharesMicro: q.sharesMicro.toString(),
    maxPriceBp,
    feeRateBp: fee.rateBp,
    feeExpMilli: fee.expMilli,
    quote: { vwapBp: q.vwapBp, allInPriceBp: q.allInPriceBp, feeMicro: q.feeMicro.toString() },
    geo: { blocked: g.blocked, country: g.country ?? null, closedOnly: g.closedOnly ?? false },
    bookTsMs: book.fetchedAtMs,
  };

  try {
    const attempt = await prisma.orderAttempt.create({
      data: {
        userId: user.id,
        marketId: market.id,
        dir: "ENTRY",
        side,
        tokenId,
        idempotencyKey: crypto.randomUUID(),
        approvedParams: approvedParams as never,
        allInCapMicro: budgetMicro,
        maxPriceBp,
        state: "ISSUED",
      },
    });
    return NextResponse.json({ intentId: attempt.id, params: approvedParams });
  } catch (e) {
    // order_attempts_one_inflight partial unique: an attempt is already active on this market.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const existing = await prisma.orderAttempt.findFirst({
        where: { userId: user.id, marketId: market.id, state: { in: ["ISSUED", "SIGNED", "SUBMITTING", "POSTED"] } },
      });
      if (existing && existing.state === "ISSUED") {
        return NextResponse.json({ intentId: existing.id, params: existing.approvedParams });
      }
      return NextResponse.json({ error: "attempt_in_flight" }, { status: 409 });
    }
    await captureToGlitchTip(e, { route: "real/intent" });
    throw e;
  }
}
