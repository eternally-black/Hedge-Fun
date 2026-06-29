// Resolve a TXODDS football O/U market from live TxLINE scores. Pure compute (fetch + decide) — the
// DB transaction stays in settleMarket(). Over wins iff total goals strictly exceed the line.
import { fetchMatchScore, onchainAnchorRef } from "../src/lib/txodds";
import type { Resolution } from "./settle";

const LINE_OF: Record<string, number> = { OU15: 1.5, OU25: 2.5, OU35: 3.5 };

// Parse a synthetic TXODDS market id "txline:{fixtureId}:{OU15|OU25|OU35}". null = not a TXODDS O/U.
export function parseTxMarketId(polymarketId: string): { fixtureId: number; line: number } | null {
  const m = /^txline:(\d+):(OU\d+)$/.exec(polymarketId);
  if (!m) return null;
  const line = LINE_OF[m[2]];
  return line == null ? null : { fixtureId: Number(m[1]), line };
}

// Pure settlement decision (offline-testable, no network). Over (YES) wins iff total goals strictly
// exceed the line. Stays {open} until the match is ended — by the feed's phase (F/FET/FPE…) OR, as a
// fallback for feeds that lag the phase, once past the regulation+cushion settle deadline WITH score
// data present. Never settles a no-data match (a postponed/blank fixture would otherwise read 0-0).
export function decideOuResolution(a: {
  line: number;
  home: number | null;
  away: number | null;
  endedPhase: boolean;
  abandoned: boolean;
  pastDeadline: boolean;
}): Resolution {
  // Postponed/abandoned/suspended: never settle on a partial score (a match played to 0-1 then
  // postponed must not resolve Under) — stays open until it genuinely ends, or an ops void.
  if (a.abandoned) return { kind: "open" };
  const hasData = a.home != null;
  const ended = a.endedPhase || (a.pastDeadline && hasData);
  if (!ended || !hasData) return { kind: "open" };
  const total = (a.home ?? 0) + (a.away ?? 0);
  return { kind: "resolved", resolvedYes: total > a.line };
}

export async function resolveFootball(
  polymarketId: string,
  resolutionDeadlineMs: number,
): Promise<{ resolution: Resolution; onchainRef: string | null }> {
  const parsed = parseTxMarketId(polymarketId);
  if (!parsed) return { resolution: { kind: "open" }, onchainRef: null };

  const score = await fetchMatchScore(parsed.fixtureId); // may throw -> transient, retried next tick
  const resolution = decideOuResolution({
    line: parsed.line,
    home: score.home,
    away: score.away,
    endedPhase: score.ended,
    abandoned: score.abandoned,
    pastDeadline: Date.now() > resolutionDeadlineMs,
  });
  // Stamp the Solana-anchored ref only when we actually settle.
  return { resolution, onchainRef: resolution.kind === "resolved" ? onchainAnchorRef() : null };
}
