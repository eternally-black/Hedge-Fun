// GET /api/real/exit-quote?ids=<betId,...> — what the user's OPEN real positions are worth RIGHT
// NOW if sold at market, and whether that is a gain or a loss against what they paid.
//
// Until this existed, "Close" asked "sell now?" and nothing more: the user was told to confirm a
// sale without being told the price. The number here is quoted the same way the sale itself is —
// quoteSellAllIn over the same book, the same fee, the same pro-rata fee-inclusive basis
// bookExitFills realizes (costBasisMicro) — so the figure on the row is the figure that books.
//
// Poll cost: one cached book read per position per poll, and the book cache is process-wide with a
// 1s TTL, so a 1s client cadence collapses to at most one upstream /books call per market per second
// no matter how many users are watching.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import { hasRealConsent } from "@/lib/real";
import { rateLimit } from "@/lib/ratelimit";
import { getBook } from "@/lib/clob";
import { getMarketFee } from "@/lib/fees";
import { centsFromMicro, costBasisMicro, quoteSellAllIn } from "@/lib/quote";
import { SHARE_TICK_MICRO, QUOTES_RATE_PER_MIN, EXIT_QUOTES_MAX_IDS } from "@/lib/config";
import type { ExitQuoteRow, ExitQuotesResponse } from "@/lib/api-types";

export async function GET(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Consent-gated, NOT eligibility-gated — same rule as /api/real/positions: a flipped allowlist
  // must never stop someone seeing (or valuing) money they already have on the table.
  if (!hasRealConsent(user)) return NextResponse.json({ error: "consent_required" }, { status: 403 });
  if (!rateLimit(`exit-quote:${user.id}`, QUOTES_RATE_PER_MIN, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const ids = [...new Set((new URL(req.url).searchParams.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean))]
    .slice(0, EXIT_QUOTES_MAX_IDS);
  if (ids.length === 0) return NextResponse.json({ quotes: [] } satisfies ExitQuotesResponse);

  // userId in the WHERE, not just the id list: these are somebody's positions, and an id from
  // another account must return nothing rather than that account's P&L.
  const bets = await prisma.bet.findMany({
    where: { id: { in: ids }, userId: user.id, mode: "REAL" },
    include: {
      market: {
        select: {
          id: true, polymarketId: true, source: true, status: true, yesTokenId: true, noTokenId: true,
          negRisk: true, feeRateBp: true, feeExpMilli: true, feeUpdatedAt: true, // the fee cache row getMarketFee reads/refreshes
        },
      },
    },
  });

  const quotes = (
    await Promise.all(
      bets.map(async (bet): Promise<ExitQuoteRow | null> => {
        // Same "is there anything to sell" test the EXIT intent applies, so a row can never show a
        // price for a position the sell path would refuse: OPEN market, remainder of at least one
        // share tick, floored to the tick the signer works in.
        if (bet.market.source !== "POLYMARKET" || bet.market.status !== "OPEN") return null;
        const remainder = (bet.filledSharesMicro ?? 0n) - (bet.closedSharesMicro ?? 0n);
        if (remainder < SHARE_TICK_MICRO) return null;
        const shares = (remainder / SHARE_TICK_MICRO) * SHARE_TICK_MICRO;

        const tokenId = bet.side === "YES" ? bet.market.yesTokenId : bet.market.noTokenId;
        if (!tokenId) return null;
        const book = await getBook(tokenId).catch(() => null);
        if (!book) return null; // a missing book is "no live number", not an error the sheet should show

        const fee = await getMarketFee(prisma, bet.market);
        const q = quoteSellAllIn(book.bids, shares, fee.rateBp, fee.expMilli);
        if (!q) return null; // no bids — nothing to sell into, so there is no honest number to show

        const basis = costBasisMicro(bet.spendMicro ?? 0n, bet.feeMicro ?? 0n, bet.filledSharesMicro ?? 0n, shares);
        // micro-USD → cents, floored toward −infinity (centsFromMicro) — the same conversion
        // /api/history and settlement use, so the live number and the settled one round alike.
        return {
          betId: bet.id,
          sharesMicro: shares.toString(),
          proceedsCents: centsFromMicro(q.netMicro),
          pnlCents: centsFromMicro(q.netMicro - basis),
          priceBp: q.vwapBp,
          partial: q.exhaustedBook, // the bids ran out: this values only what the book can absorb
        };
      }),
    )
  ).filter((q): q is ExitQuoteRow => q !== null);

  return NextResponse.json({ quotes } satisfies ExitQuotesResponse, { headers: { "Cache-Control": "no-store" } });
}
