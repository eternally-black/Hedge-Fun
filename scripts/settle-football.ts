// Resolve a TXODDS football O/U market from live TxLINE scores. Pure compute (fetch + decide) — the
// DB transaction stays in settleMarket(). Over wins iff total goals strictly exceed the line.
import { fetchMatchScore, onchainAnchorRef } from "../src/lib/txodds";
import type { Resolution } from "./settle";

const LINE_OF: Record<string, number> = { OU15: 1.5, OU25: 2.5, OU35: 3.5 };

// Parse a synthetic TXODDS market id "txline:{fixtureId}:{kind}". kind = OU15|OU25|OU35 (total goals)
// or WINH|WINA (home/away to win). null = not a recognized TXODDS market.
export type TxMarket =
  | { fixtureId: number; kind: "OU"; line: number }
  | { fixtureId: number; kind: "WIN"; team: "home" | "away" };
export function parseTxMarketId(polymarketId: string): TxMarket | null {
  const m = /^txline:(\d+):(OU\d+|WINH|WINA)$/.exec(polymarketId);
  if (!m) return null;
  const fixtureId = Number(m[1]);
  if (m[2] === "WINH") return { fixtureId, kind: "WIN", team: "home" };
  if (m[2] === "WINA") return { fixtureId, kind: "WIN", team: "away" };
  const line = LINE_OF[m[2]!];
  return line == null ? null : { fixtureId, kind: "OU", line };
}

// Shared settle gate: a match settles only when it's genuinely ended WITH score data, and never when
// abandoned/postponed/suspended (a partial score must not resolve). Ended = the feed's phase (F/FET…)
// OR, as a fallback for feeds that lag the phase, past the regulation+cushion deadline WITH data.
function settleable(a: { home: number | null; endedPhase: boolean; abandoned: boolean; pastDeadline: boolean }): boolean {
  if (a.abandoned) return false;
  const hasData = a.home != null;
  return (a.endedPhase || (a.pastDeadline && hasData)) && hasData;
}

// Over (YES) wins iff total goals strictly exceed the line. Offline-testable, no network.
export function decideOuResolution(a: {
  line: number;
  home: number | null;
  away: number | null;
  endedPhase: boolean;
  abandoned: boolean;
  pastDeadline: boolean;
}): Resolution {
  if (!settleable(a)) return { kind: "open" };
  const total = (a.home ?? 0) + (a.away ?? 0);
  return { kind: "resolved", resolvedYes: total > a.line };
}

// "{team} to win?" (YES) wins iff that team's goals strictly exceed the other's (a draw → NO on both).
export function decideWinResolution(a: {
  team: "home" | "away";
  home: number | null;
  away: number | null;
  endedPhase: boolean;
  abandoned: boolean;
  pastDeadline: boolean;
}): Resolution {
  if (!settleable(a)) return { kind: "open" };
  const h = a.home ?? 0;
  const aw = a.away ?? 0;
  return { kind: "resolved", resolvedYes: a.team === "home" ? h > aw : aw > h };
}

export async function resolveFootball(
  polymarketId: string,
  resolutionDeadlineMs: number,
): Promise<{ resolution: Resolution; onchainRef: string | null }> {
  const parsed = parseTxMarketId(polymarketId);
  if (!parsed) return { resolution: { kind: "open" }, onchainRef: null };

  const score = await fetchMatchScore(parsed.fixtureId); // may throw -> transient, retried next tick
  const common = {
    home: score.home,
    away: score.away,
    endedPhase: score.ended,
    abandoned: score.abandoned,
    pastDeadline: Date.now() > resolutionDeadlineMs,
  };
  const resolution =
    parsed.kind === "OU"
      ? decideOuResolution({ line: parsed.line, ...common })
      : decideWinResolution({ team: parsed.team, ...common });
  // Stamp the Solana-anchored ref only when we actually settle.
  return { resolution, onchainRef: resolution.kind === "resolved" ? onchainAnchorRef() : null };
}
