import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import type { HistoryResponse } from "@/lib/api-types";
import { SHARE_TICK_MICRO } from "@/lib/config";
import { centsFromMicro } from "@/lib/quote";
import { categoryOf, gameOf } from "@/lib/deck-mix";
import { effectiveRealMode } from "@/lib/real";
import { rateLimit } from "@/lib/ratelimit";
import { encodeKeysetCursor, decodeKeysetCursor } from "@/lib/cursor";

// Prediction history: the user's bets joined with market info. PENDING (awaiting resolution)
// first, then most-recently-settled. Returns the REAL side label the user picked (team/Over/Up/
// Yes), the status, and P&L in cents for settled bets.
export async function GET(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!rateLimit(`history:${user.id}`, 120, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  // Follows the account's MODE: a real-money user opening their history wants their real positions,
  // and showing paper bets under a real-money header is the same lie the mode flag exists to prevent.
  const mode = effectiveRealMode(user);
  const cursor = new URL(req.url).searchParams.get("cursor");
  const after = cursor ? decodeKeysetCursor(cursor) : null;
  // Keyset on (createdAt desc, id desc) — a stable total order across pages. Over-fetch by one so
  // we can tell whether another page exists (51 rows = yes, drop the last and emit a cursor).
  const bets = await prisma.bet.findMany({
    where: {
      userId: user.id,
      mode,
      ...(after
        ? { OR: [{ createdAt: { lt: after.at } }, { createdAt: after.at, id: { lt: after.id } }] }
        : {}),
    },
    // Pending first (settlementStatus PENDING < SETTLED alphabetically is wrong, so order by a
    // computed flag): we sort in JS below. The keyset order is the pagination order, not the
    // display order — the JS sort below re-orders WITHIN the page.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 51,
    select: {
      id: true,
      marketId: true, // the EXIT intent is placed against the market, not the bet
      side: true,
      stakeCents: true,
      lockedPriceBp: true,
      settlementStatus: true,
      result: true,
      pnlCents: true,
      createdAt: true,
      settledAt: true,
      // REAL columns. A real position does not settle through the paper job — settlementStatus stays
      // PENDING on it forever — so its status and P&L are derived from these instead (below).
      filledSharesMicro: true,
      closedSharesMicro: true,
      realizedPnlMicro: true,
      market: {
        select: {
          question: true, outcomeYesLabel: true, outcomeNoLabel: true, resolutionDeadline: true, status: true,
          startsAt: true, // kick-off — a match "deadline" IS its kick-off, see HistoryRow
          league: true, // the sport/game named at ingest — the row states it in its subtitle
        },
      },
    },
  });

  // 51 rows = there is at least one more page. Drop the over-fetched row and remember where the
  // next page starts (the last row we actually keep).
  const hasMore = bets.length === 51;
  if (hasMore) bets.pop();
  const nextCursor = hasMore
    ? encodeKeysetCursor(bets[bets.length - 1]!.createdAt, bets[bets.length - 1]!.id)
    : null;

  const rows: HistoryResponse["rows"] = bets.map((b) => {
    // A REAL position is "open" while it still holds shares and "done" once the remainder is gone —
    // whether that came from selling out or from redeeming a resolved market. Its outcome is the
    // MONEY outcome, not the market's: exiting a position at a profit on a market that later
    // resolves against you is a win for the person who took it, and the ledger already says so.
    const filled = b.filledSharesMicro ?? 0n;
    const remainder = filled - (b.closedSharesMicro ?? 0n);
    const realizedMicro = b.realizedPnlMicro ?? 0n;
    // A remainder below one share tick is not an open position: the signer cannot sell it, so it
    // can never be closed and would sit as "open" forever. The same rule the intent route applies.
    const realOpen = mode === "REAL" && (filled === 0n || remainder >= SHARE_TICK_MICRO);
    const realStatus: "PENDING" | "WIN" | "LOSS" | "PUSH" = realOpen
      ? "PENDING"
      : realizedMicro > 0n
        ? "WIN"
        : realizedMicro < 0n
          ? "LOSS"
          : "PUSH";

    // Can the user close this from the history sheet? Only a REAL position with something the
    // signer can actually sell: it works in 4-decimal shares, so a sub-tick remnant is unsellable
    // by construction and offering a button for it would produce nothing but a refusal.
    // Only a market that is still OPEN can be traded out of. Offering Close on one that has already
    // resolved is offering a button the exchange will refuse — the position there is not sold, it is
    // redeemed, and the server does that on its own.
    // ...and only while the market is still OPEN. NOT "before the deadline": that gate shipped on
    // the theory that Polymarket shuts the book at endDate, and a live market disproved it within
    // the hour — "MGS Panserraikos vs. APS Panthrakikos: 1st Half O/U 0.5" was still closed:false,
    // active:true and quoting 99.55c/0.45c thirty minutes past its endDate. endDate is a schedule,
    // not a closing bell, and taking the exit away from someone whose position is still trading is
    // the worse error: the resolved-but-not-yet-flipped window it was meant to cover now lasts one
    // poller tick (the chain fallback in scripts/poller.ts), and a sell into a shut book fails
    // loudly and moves no money.
    const closable = realOpen && remainder >= SHARE_TICK_MICRO && b.market.status === "OPEN";

    return {
    id: b.id,
    marketId: b.marketId,
    closable,
    question: b.market.question,
    // Same derivation the deck and the results inbox use, so one row component can render either
    // list without asking which endpoint it came from.
    ...(() => {
      const cat = categoryOf(b.market);
      return { category: cat, league: b.market.league ?? gameOf(b.market, cat) };
    })(),
    // The label of the side the user actually bet (YES = side A label, NO = side B label).
    sideLabel: b.side === "YES" ? b.market.outcomeYesLabel : b.market.outcomeNoLabel,
    side: b.side, // "YES" | "NO" — drives the badge color
    stakeCents: b.stakeCents,
    lockedPriceBp: b.lockedPriceBp,
    status: mode === "REAL" ? realStatus : b.settlementStatus === "PENDING" ? "PENDING" : b.result,
    // micro-USD → cents, floored (centsFromMicro): display-only — the ledger keeps the micros.
    pnlCents: mode === "REAL" ? centsFromMicro(realizedMicro) : b.pnlCents,
    resolutionDeadline: b.market.resolutionDeadline.toISOString(),
    startsAt: b.market.startsAt?.toISOString() ?? null,
    createdAt: b.createdAt.toISOString(),
    settledAt: b.settledAt?.toISOString() ?? null,
    };
  });

  // Pending first (most urgent / what the user wants to glance at), then settled by recency.
  rows.sort((a, b) => {
    const ap = a.status === "PENDING" ? 0 : 1;
    const bp = b.status === "PENDING" ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return +new Date(b.createdAt) - +new Date(a.createdAt);
  });

  // pendingCount is the FULL-set count, not the windowed one — a user at the 10-swipes/day cap
  // crosses 100 bets in under two weeks, and a count derived from the page would under-report
  // pending positions that fell outside it. PAPER counts the settlementStatus column directly;
  // REAL derives "open" from the share remainder (the same rule the row mapper applies above), so
  // it needs a raw count — Prisma can't express the arithmetic in a where.
  const pendingCount =
    mode === "PAPER"
      ? await prisma.bet.count({ where: { userId: user.id, mode: "PAPER", settlementStatus: "PENDING" } })
      : Number(
          (
            await prisma.$queryRaw<{ n: bigint }[]>`
              SELECT COUNT(*)::bigint AS n FROM "bets"
              WHERE "userId" = ${user.id} AND "mode" = 'REAL'
                AND ("filledSharesMicro" IS NULL OR "filledSharesMicro" = 0
                     OR "filledSharesMicro" - COALESCE("closedSharesMicro", 0) >= ${SHARE_TICK_MICRO})
            `
          )[0]!.n,
        );
  const body: HistoryResponse = { rows, pendingCount, nextCursor };
  return NextResponse.json(body);
}
