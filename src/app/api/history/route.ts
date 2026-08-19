import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import type { HistoryResponse } from "@/lib/api-types";
import { SHARE_TICK_MICRO } from "@/lib/config";

// Prediction history: the user's bets joined with market info. PENDING (awaiting resolution)
// first, then most-recently-settled. Returns the REAL side label the user picked (team/Over/Up/
// Yes), the status, and P&L in cents for settled bets.
export async function GET(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Follows the account's MODE: a real-money user opening their history wants their real positions,
  // and showing paper bets under a real-money header is the same lie the mode flag exists to prevent.
  const mode = user.realMode ? "REAL" : "PAPER";
  const bets = await prisma.bet.findMany({
    where: { userId: user.id, mode },
    // Pending first (settlementStatus PENDING < SETTLED alphabetically is wrong, so order by a
    // computed flag): we sort in JS below. Pull a generous recent window.
    orderBy: { createdAt: "desc" },
    take: 100,
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
        select: { question: true, outcomeYesLabel: true, outcomeNoLabel: true, resolutionDeadline: true, status: true },
      },
    },
  });

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
    // ...and only while the market is still TRADABLE. Past its deadline Polymarket has closed the
    // book: the sell would be refused by the exchange, and our cached OPEN status is just a poll
    // behind reality. Offering the button there is offering an action that cannot work — precisely
    // in the window where the market has resolved, the collateral may already have been redeemed,
    // and the row still reads "awaiting result".
    const closable =
      realOpen &&
      remainder >= SHARE_TICK_MICRO &&
      b.market.status === "OPEN" &&
      b.market.resolutionDeadline.getTime() > Date.now();

    return {
    id: b.id,
    marketId: b.marketId,
    closable,
    question: b.market.question,
    // The label of the side the user actually bet (YES = side A label, NO = side B label).
    sideLabel: b.side === "YES" ? b.market.outcomeYesLabel : b.market.outcomeNoLabel,
    side: b.side, // "YES" | "NO" — drives the badge color
    stakeCents: b.stakeCents,
    lockedPriceBp: b.lockedPriceBp,
    status: mode === "REAL" ? realStatus : b.settlementStatus === "PENDING" ? "PENDING" : b.result,
    // micro-USD → cents. Truncates sub-cent dust, which is display-only: the ledger keeps the micros.
    pnlCents: mode === "REAL" ? Number(realizedMicro / 10_000n) : b.pnlCents,
    resolutionDeadline: b.market.resolutionDeadline.toISOString(),
    createdAt: b.createdAt.toISOString(),
    };
  });

  // Pending first (most urgent / what the user wants to glance at), then settled by recency.
  rows.sort((a, b) => {
    const ap = a.status === "PENDING" ? 0 : 1;
    const bp = b.status === "PENDING" ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return +new Date(b.createdAt) - +new Date(a.createdAt);
  });

  const pendingCount = rows.filter((r) => r.status === "PENDING").length;
  return NextResponse.json({ rows, pendingCount });
}
