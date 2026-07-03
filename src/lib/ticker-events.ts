import type { TickerRow } from "./api-types";

// Pure diff of two consecutive ticker polls → broadcast event lines for the marquee. Reuses the
// per-poll comparison the ticker already did for its color flash, but composes a spoken line and
// cites both markets (Over 2.5 + 1X2 win). No React, no I/O → unit-testable in isolation.

export interface TickerBaseline {
  total: number | null; // home+away goals, null pre-match
  ou: number | null; // Over-2.5 %
  homeWin: number | null; // 1X2 home-win %
  awayWin: number | null;
}
export interface TickerEvent {
  fixtureId: string;
  kind: "goal" | "swing";
  text: string;
}
export type RowFlash = "goal" | "up" | "down"; // per-row color/arrow on the compact strip
export interface DeriveResult {
  events: TickerEvent[]; // broadcast banner lines (threshold-gated swings)
  flash: Record<string, RowFlash>; // per-fixture row flash (any O2.5 move → arrow, goal → gold)
}
export interface DeriveOpts {
  swingMin: number; // min percentage-point move to broadcast an odds SWING banner (no goal this tick)
}

const round = (v: number) => Math.round(v);
const arrow = (from: number, to: number) => (to > from ? "▲" : to < from ? "▼" : "");
const baselineOf = (r: TickerRow): TickerBaseline => ({
  total: r.homeGoals == null ? null : r.homeGoals + (r.awayGoals ?? 0),
  ou: r.over25Pct,
  homeWin: r.homeWinPct,
  awayWin: r.awayWinPct,
});
const moved = (from: number | null, to: number | null, min: number) =>
  from != null && to != null && Math.abs(to - from) >= min;

// Current 1X2 leader + its arrow vs the previous baseline, as a " · {team} win {pct}%▲" segment.
function winSegment(r: TickerRow, p: TickerBaseline): string {
  const cands: Array<{ team: string; pct: number; prev: number | null }> = [];
  if (r.homeWinPct != null) cands.push({ team: r.home, pct: r.homeWinPct, prev: p.homeWin });
  if (r.awayWinPct != null) cands.push({ team: r.away, pct: r.awayWinPct, prev: p.awayWin });
  if (cands.length === 0) return "";
  const lead = cands.reduce((a, b) => (b.pct > a.pct ? b : a));
  return ` · ${lead.team} win ${round(lead.pct)}%${lead.prev != null ? arrow(lead.prev, lead.pct) : ""}`;
}

// Single pass over `rows`: build events AND update `prev` in place (js-combine-iterations), reading
// the baseline Map by fixtureId for O(1) lookups (js-index-maps). `prev` is mutated to the new
// baseline exactly like the ticker's existing prev-ref bookkeeping.
export function deriveTickerEvents(
  prev: Map<string, TickerBaseline>,
  rows: TickerRow[],
  opts: DeriveOpts,
): DeriveResult {
  const events: TickerEvent[] = [];
  const flash: Record<string, RowFlash> = {};
  for (const r of rows) {
    const next = baselineOf(r);
    const p = prev.get(r.fixtureId);
    prev.set(r.fixtureId, next);
    if (!p) continue; // first sighting → seed baseline, never fire (no false "goal" on load / null→0-0)

    // Goal: total strictly increased from a KNOWN numeric baseline (kickoff null→0-0 is not a goal;
    // a VAR-disallowed decrease is not a goal either — baseline just re-seeds silently).
    if (p.total != null && next.total != null && next.total > p.total) {
      flash[r.fixtureId] = "goal";
      const ph = r.phase ? ` · ${r.phase}` : "";
      const ouSeg =
        r.over25Pct != null ? ` · O2.5 ${round(r.over25Pct)}%${p.ou != null ? arrow(p.ou, r.over25Pct) : ""}` : "";
      events.push({
        fixtureId: r.fixtureId,
        kind: "goal",
        text: `⚽ GOAL${ph} — ${r.home} ${r.homeGoals}–${r.awayGoals} ${r.away}${ouSeg}${winSegment(r, p)}`,
      });
      continue;
    }

    // Row flash: ANY O2.5 move colors the row arrow (unchanged from the original ticker behavior).
    if (p.ou != null && next.ou != null && next.ou !== p.ou) {
      flash[r.fixtureId] = next.ou > p.ou ? "up" : "down";
    }

    // Swing banner: no goal, but an odds line moved past the threshold. Show only what moved.
    const ouMoved = moved(p.ou, next.ou, opts.swingMin);
    const winMoved =
      moved(p.homeWin, next.homeWin, opts.swingMin) || moved(p.awayWin, next.awayWin, opts.swingMin);
    if (ouMoved || winMoved) {
      const ouSeg =
        ouMoved && r.over25Pct != null && p.ou != null ? ` · O2.5 ${round(r.over25Pct)}%${arrow(p.ou, r.over25Pct)}` : "";
      events.push({
        fixtureId: r.fixtureId,
        kind: "swing",
        text: `📈 ${r.home} v ${r.away}${ouSeg}${winMoved ? winSegment(r, p) : ""}`,
      });
    }
  }
  return { events, flash };
}
