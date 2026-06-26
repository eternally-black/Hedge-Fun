import type { Prisma } from "@prisma/client";
import type { ResultRow } from "./api-types";

// Shared select + mapper for a settled bet -> ResultRow. /api/results uses it; /api/history
// reuses the same select shape so the two views never drift on what a "bet row" is.
//
// outcome is built purely from data (resolvedOutcome + side labels) — no LLM:
//   RESOLVED YES  -> "Resolved <outcomeYesLabel>"
//   RESOLVED NO   -> "Resolved <outcomeNoLabel>"
//   VOID/INVALID  -> "Voided"   (canceled market -> push)
export const resultBetSelect = {
  id: true,
  side: true,
  pnlCents: true,
  result: true,
  settlementStatus: true,
  settledAt: true,
  seenAt: true,
  market: {
    select: { question: true, category: true, outcomeYesLabel: true, outcomeNoLabel: true, resolvedOutcome: true },
  },
  shardGrant: { select: { counted: true } },
} satisfies Prisma.BetSelect;

type ResultBet = Prisma.BetGetPayload<{ select: typeof resultBetSelect }>;

function outcomeLabel(b: ResultBet): string {
  if (b.market.resolvedOutcome === "YES") return `Resolved ${b.market.outcomeYesLabel}`;
  if (b.market.resolvedOutcome === "NO") return `Resolved ${b.market.outcomeNoLabel}`;
  return "Voided"; // INVALID / null (canceled market -> push)
}

export function toResultRow(b: ResultBet): ResultRow {
  const pnl = b.pnlCents ?? 0;
  return {
    id: b.id,
    question: b.market.question,
    category: b.market.category,
    side: b.side,
    sideLabel: b.side === "YES" ? b.market.outcomeYesLabel : b.market.outcomeNoLabel,
    status: b.result === "WIN" ? "WIN" : b.result === "LOSS" ? "LOSS" : "PUSH",
    outcome: outcomeLabel(b),
    pnlCents: pnl,
    deltaCents: pnl,
    // A grant exists only for a win; counted=false (over daily cap) still earned the bet but added 0.
    shards: b.shardGrant?.counted ? 1 : 0,
    settledAt: (b.settledAt ?? new Date(0)).toISOString(), // settled rows always have settledAt; fallback is defensive
    seen: b.seenAt != null,
  };
}
