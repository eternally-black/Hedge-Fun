import type { Prisma } from "@prisma/client";
import type { ResultRow, StockAlertRow } from "./api-types";
import { categoryOf, gameOf } from "./deck-mix";
import type { PnlFn } from "./stock-alerts";

// A stock profit alert as the inbox shows it. P&L is LIVE (the stored asset price at read time) —
// the honest number for a "take profit?" nudge — while tierBp is what fired. `pnl` is injected
// (livePnlCents in production) so the unit math has exactly one owner.
export function toStockAlertRow(
  p: Prisma.StockPositionGetPayload<{ include: { asset: true } }>,
  pnl: PnlFn,
): StockAlertRow {
  const a = p.asset;
  const pnlCents = a.priceCents != null ? pnl(p, { priceCents: a.priceCents, decimals: a.decimals }) : 0;
  return {
    positionId: p.id,
    symbol: a.symbol,
    name: a.name,
    logoUrl: a.logoUrl,
    mode: p.mode,
    tierBp: p.alertTierBp,
    pnlCents,
    pnlBp: p.costCents > 0 ? Math.floor((pnlCents * 10_000) / p.costCents) : 0,
    costCents: p.costCents,
    alertedAt: (p.alertedAt ?? p.createdAt).toISOString(),
    seen: p.alertSeenAt != null,
  };
}

// Shared select + mapper for a settled bet -> ResultRow. Used by /api/results. (/api/history has
// its OWN inline select — the two are not shared, despite what this comment used to claim.)
//
// outcome is built purely from data (resolvedOutcome + side labels) — no LLM:
//   RESOLVED YES  -> "Resolved <outcomeYesLabel>"
//   RESOLVED NO   -> "Resolved <outcomeNoLabel>"
//   VOID/INVALID  -> "Voided"   (canceled market -> push)
export const resultBetSelect = {
  id: true,
  side: true,
  stakeCents: true,
  lockedPriceBp: true,
  createdAt: true,
  pnlCents: true,
  result: true,
  settlementStatus: true,
  settledAt: true,
  seenAt: true,
  market: {
    select: {
      question: true,
      category: true,
      league: true,
      outcomeYesLabel: true,
      outcomeNoLabel: true,
      resolvedOutcome: true,
    },
  },
  shardGrant: { select: { counted: true } },
} satisfies Prisma.BetSelect;

type ResultBet = Prisma.BetGetPayload<{ select: typeof resultBetSelect }>;

function outcomeLabel(b: ResultBet): string {
  if (b.market.resolvedOutcome === "YES") return `Resolved ${b.market.outcomeYesLabel}`;
  if (b.market.resolvedOutcome === "NO") return `Resolved ${b.market.outcomeNoLabel}`;
  // A REAL position sold out before resolution is SETTLED while the market is still undecided —
  // that is the exit's verdict, not a void. Only VOID/INVALID rows should read as voided.
  if (b.settlementStatus === "SETTLED") return "Closed early";
  return "Voided"; // INVALID / null (canceled market -> push)
}

export function toResultRow(b: ResultBet): ResultRow {
  const pnl = b.pnlCents ?? 0;
  return {
    id: b.id,
    question: b.market.question,
    // Derived, like the deck's — Gamma's own `category` is null on every market, so passing it
    // through left the RN inbox showing a grey "Market" chip on every settled row.
    ...(() => {
      const m = {
        question: b.market.question,
        outcomeYesLabel: b.market.outcomeYesLabel,
        outcomeNoLabel: b.market.outcomeNoLabel,
      };
      const cat = categoryOf(m);
      // Stored name first — it came from Polymarket's tags at ingest and is the only thing that
      // knows a club-vs-club row is soccer (see MarketCache.league).
      return { category: cat, league: b.market.league ?? gameOf(m, cat) };
    })(),
    side: b.side,
    sideLabel: b.side === "YES" ? b.market.outcomeYesLabel : b.market.outcomeNoLabel,
    stakeCents: b.stakeCents,
    lockedPriceBp: b.lockedPriceBp,
    createdAt: b.createdAt.toISOString(),
    status: b.result === "WIN" ? "WIN" : b.result === "LOSS" ? "LOSS" : "PUSH",
    outcome: outcomeLabel(b),
    pnlCents: pnl,
    deltaCents: pnl,
    // A grant exists only for a win; counted=false (over daily cap) still earned the bet but added 0.
    shards: b.shardGrant?.counted ? 1 : 0,
    settledAt: (b.settledAt ?? new Date(0)).toISOString(), // settled rows always have settledAt; fallback is defensive
    seen: b.seenAt != null,
    // Deprecated v1 keys. The only verifiable source (TxOdds, Solana-anchored scores) is gone and
    // neither client renders the badge anymore, but the contract rule is "don't remove/rename in
    // place" (src/lib/api-types.ts) — mobile does not deploy atomically with the server. So they are
    // emitted as constants rather than dropped, and the columns keep the historical truth.
    verified: false,
    onchainRef: null,
  };
}
