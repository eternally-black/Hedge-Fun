// POST /api/real/intent — phase 1 of the two-phase order protocol (plan §2.1): the server derives
// EXACT order params from a fresh fee-inclusive quote and persists a durable OrderAttempt BEFORE
// anything is signed. The client signs exactly these params; submit validates the signed order
// against THIS row. One in-flight attempt per (user, market) — DB partial unique, not app logic.
// Supports both ENTRY (BUY into a position) and EXIT (SELL out of it) via the optional `dir` body
// field (default ENTRY). EXIT is the close-only tier path: restricted users may still exit.
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import { isRealMoneyEligible, hasRealConsent, sameOrigin } from "@/lib/real";
import { captureToGlitchTip } from "@/lib/glitchtip";
import { getMarketFee } from "@/lib/fees";
import { getBook } from "@/lib/clob";
import { quoteBuyAllIn, quoteSellAllIn } from "@/lib/quote";
import { STAKE_CENTS, HEDGE_MIN_STAKE_CENTS, HEDGE_MAX_STAKE_CENTS, SWIPE_CAP, DECK_MIN_LEAD_MS } from "@/lib/config";

export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isRealMoneyEligible(user)) return NextResponse.json({ error: "real_disabled" }, { status: 403 });
  if (!hasRealConsent(user)) return NextResponse.json({ error: "consent_required" }, { status: 403 });
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  if (!user.depositWalletAddress || !user.embeddedWalletAddress) {
    return NextResponse.json({ error: "no_deposit_wallet" }, { status: 409 });
  }

  let marketId: unknown, side: unknown, stakeCents: unknown, geo: unknown, dir: unknown;
  try {
    ({ marketId, side, stakeCents, geo, dir } = await req.json());
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  if (typeof marketId !== "string" || (side !== "YES" && side !== "NO")) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const direction = dir === "EXIT" ? "EXIT" : "ENTRY"; // default ENTRY; anything else is ENTRY

  // Geo (plan §2.7): the browser-reported verdict is REQUIRED for both arms and recorded on the
  // attempt. It is policy, not proof — Polymarket's own IP rejection is the real barrier.
  // EXIT: blocked/closedOnly users ARE allowed — the close-only tier exists so a restricted user
  // can still exit their position (spec §6.3). ENTRY: blocked/closedOnly are rejected outright.
  const g = geo as { blocked?: boolean; country?: string; closedOnly?: boolean } | undefined;
  if (!g || typeof g.blocked !== "boolean") return NextResponse.json({ error: "geo_required" }, { status: 400 });
  if (direction === "ENTRY" && (g.blocked || g.closedOnly)) {
    return NextResponse.json({ error: "geo_blocked" }, { status: 403 });
  }

  // Q1: real swipes consume the DECK cap — enforce at intent time (booking re-checks at fill).
  // EXIT is NOT a swipe (closing a position is not a new swipe), so no cap check for EXIT.
  if (direction === "ENTRY") {
    const utcDay = new Date().toISOString().slice(0, 10);
    const counter = await prisma.dailyCounter.findUnique({ where: { userId_utcDay: { userId: user.id, utcDay } } });
    if ((counter?.swipeCount ?? 0) >= SWIPE_CAP) {
      return NextResponse.json({ error: "daily swipe limit reached" }, { status: 403 });
    }
  }

  const market = await prisma.market.findUnique({ where: { id: marketId } });
  if (!market || market.source !== "POLYMARKET" || market.status !== "OPEN") {
    return NextResponse.json({ error: "market_unavailable" }, { status: 409 });
  }
  // ENTRY: near-deadline markets are excluded. EXIT: closing near the deadline MUST be allowed —
  // skip the lead check (locking someone into a position at the worst moment is the harm).
  if (direction === "ENTRY" && market.resolutionDeadline.getTime() < Date.now() + DECK_MIN_LEAD_MS) {
    return NextResponse.json({ error: "market_closing" }, { status: 409 });
  }

  // Fee always; neg-risk exclusion is ENTRY-ONLY (fail-closed: unknown = excluded). EXIT must
  // never reject on negRisk — the user exits whatever they hold, however the market got flagged
  // after entry (executor-review fix: the original check ran before the branch and blocked exits).
  const fee = await getMarketFee(prisma, market);
  if (direction === "ENTRY" && fee.negRisk !== false) {
    return NextResponse.json({ error: "neg_risk_excluded" }, { status: 409 });
  }

  // EXIT: the user must hold a REAL position with a positive remainder.
  // ENTRY: the inverse — an OPEN position on this market blocks a second entry (S6/S7 review:
  // an opposite-side entry would merge both tokens into one aggregate under one `side`,
  // corrupting the position; same-side top-ups are deliberately out of alpha scope). Close first.
  let betSide: "YES" | "NO" = side;
  let remainder = 0n;
  const existingBet = await prisma.bet.findUnique({
    where: { userId_marketId_mode: { userId: user.id, marketId: market.id, mode: "REAL" } },
  });
  const existingRemainder = existingBet
    ? (existingBet.filledSharesMicro ?? 0n) - (existingBet.closedSharesMicro ?? 0n)
    : 0n;
  if (direction === "ENTRY" && existingRemainder > 0n) {
    return NextResponse.json({ error: "position_exists" }, { status: 409 });
  }
  if (direction === "EXIT") {
    if (!existingBet || existingRemainder <= 0n) return NextResponse.json({ error: "no_position" }, { status: 409 });
    remainder = existingRemainder;
    betSide = existingBet.side; // the side the user HOLDS — that's the token they sell
  }

  // The token is the side the user buys (ENTRY) or holds (EXIT).
  const tokenId = betSide === "YES" ? market.yesTokenId : market.noTokenId;
  if (!tokenId) return NextResponse.json({ error: "market_unavailable" }, { status: 409 });

  const book = await getBook(tokenId).catch(() => null);
  if (!book) return NextResponse.json({ error: "book_unavailable" }, { status: 503 });
  // Belt over the fee-cache flag (K3 F2): the raw book's own per-token neg_risk wins when it
  // disagrees or the cache came from an absent-field default. true OR unknown-on-both = excluded.
  // ENTRY-only, same rationale as above.
  if (direction === "ENTRY" && book.negRisk !== false) {
    return NextResponse.json({ error: "neg_risk_excluded" }, { status: 409 });
  }

  const tickBp = Math.round(book.tickSize * 10_000);
  if (tickBp <= 0) return NextResponse.json({ error: "book_unavailable" }, { status: 503 });

  let approvedParams: Record<string, unknown>;
  let allInCapMicro: bigint;
  let maxPriceBp: number;

  if (direction === "ENTRY") {
    const stake = typeof stakeCents === "number" && Number.isInteger(stakeCents) ? stakeCents : STAKE_CENTS;
    if (stake < HEDGE_MIN_STAKE_CENTS || stake > HEDGE_MAX_STAKE_CENTS) {
      return NextResponse.json({ error: "bad_stake" }, { status: 400 });
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
    maxPriceBp = Math.min(Math.ceil(q.marginalAskBp / tickBp) * tickBp, 10_000 - tickBp);
    allInCapMicro = budgetMicro;

    approvedParams = {
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
  } else {
    // EXIT: quote the full remainder as a SELL. quoteSellAllIn walks the book's bids.
    const q = quoteSellAllIn(book.bids, remainder, fee.rateBp, fee.expMilli);
    if (!q) return NextResponse.json({ error: "no_liquidity" }, { status: 409 });

    // minOrderSize is SHARES (trap list); reject before anyone signs an unfillable order.
    if (q.sharesMicro < BigInt(Math.round(book.minOrderSize * 1_000_000))) {
      return NextResponse.json({ error: "stake_too_small", minShares: book.minOrderSize }, { status: 409 });
    }

    // minPrice = MARGINAL bid (never VWAP), tick-rounded DOWN for a SELL (rounding up makes the
    // protection unfillable — mirror of the BUY trap), clamped >= tick.
    maxPriceBp = Math.max(Math.floor(q.marginalBidBp / tickBp) * tickBp, tickBp);
    allInCapMicro = q.proceedsMicro; // informational for EXIT — the expected proceeds, not a cap

    approvedParams = {
      side: "SELL",
      dir: "EXIT",
      tokenId,
      betSide,
      sharesMicro: remainder.toString(),
      minPriceBp: maxPriceBp,
      feeRateBp: fee.rateBp,
      feeExpMilli: fee.expMilli,
      quote: { vwapBp: q.vwapBp, netMicro: q.netMicro.toString(), proceedsMicro: q.proceedsMicro.toString() },
      geo: { blocked: g.blocked, country: g.country ?? null, closedOnly: g.closedOnly ?? false },
      bookTsMs: book.fetchedAtMs,
    };
  }

  try {
    const attempt = await prisma.orderAttempt.create({
      data: {
        userId: user.id,
        marketId: market.id,
        dir: direction,
        side: betSide,
        tokenId,
        idempotencyKey: crypto.randomUUID(),
        approvedParams: approvedParams as never,
        allInCapMicro,
        maxPriceBp, // for EXIT this column holds minPriceBp — see approvedParams.minPriceBp
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
        // A stale unsigned intent must not occupy the slot forever (S6/S7 review: an abandoned
        // ENTRY intent would block a later EXIT). Expire it and let the client retry.
        if (Date.now() - existing.updatedAt.getTime() > 10 * 60_000) {
          await prisma.orderAttempt.updateMany({
            where: { id: existing.id, state: "ISSUED" },
            data: { state: "FAILED", error: "intent_expired" },
          });
          return NextResponse.json({ error: "intent_expired_retry" }, { status: 409 });
        }
        return NextResponse.json({ intentId: existing.id, params: existing.approvedParams });
      }
      return NextResponse.json({ error: "attempt_in_flight" }, { status: 409 });
    }
    await captureToGlitchTip(e, { route: "real/intent" });
    throw e;
  }
}
