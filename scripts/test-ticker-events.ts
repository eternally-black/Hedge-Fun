// Self-check for the ticker event derivation (DB-free, pure). Verifies goal / odds-swing detection
// and the latent-bug guards (kickoff null→0-0 is not a goal; sub-threshold odds don't broadcast).
// Run: npx tsx scripts/test-ticker-events.ts
import assert from "node:assert";
import { deriveTickerEvents, type TickerBaseline } from "../src/lib/ticker-events";
import type { TickerRow } from "../src/lib/api-types";

// Full TickerRow with sane defaults; override only what a case needs.
const row = (o: Partial<TickerRow>): TickerRow => ({
  fixtureId: "1",
  competition: "World Cup",
  home: "Argentina",
  away: "France",
  homeGoals: null,
  awayGoals: null,
  live: true,
  ended: false,
  phase: "2H",
  kickoff: "2026-07-03T18:00:00.000Z",
  over25Pct: null,
  homeWinPct: null,
  awayWinPct: null,
  ...o,
});
const OPTS = { swingMin: 3 };

// A fresh baseline map, seeded by one silent poll (first sighting never fires).
const seed = (r: TickerRow) => {
  const m = new Map<string, TickerBaseline>();
  const first = deriveTickerEvents(m, [r], OPTS);
  assert.strictEqual(first.events.length, 0, "first sighting fires nothing (seeds baseline)");
  assert.strictEqual(Object.keys(first.flash).length, 0, "first sighting flashes nothing");
  return m;
};

// ---- kickoff null → 0-0 is NOT a goal (guards the latent bug in the old score-string diff) ----
{
  const m = seed(row({ homeGoals: null, awayGoals: null }));
  const { events, flash } = deriveTickerEvents(m, [row({ homeGoals: 0, awayGoals: 0 })], OPTS);
  assert.strictEqual(events.length, 0, "null→0-0 emits no goal event");
  assert.strictEqual(flash["1"], undefined, "null→0-0 sets no row flash");
}

// ---- a real goal (0-0 → 1-0) fires one goal event citing BOTH markets + gold flash ----
{
  const m = seed(row({ homeGoals: 0, awayGoals: 0, over25Pct: 55, homeWinPct: 60, awayWinPct: 25 }));
  const { events, flash } = deriveTickerEvents(
    m,
    [row({ homeGoals: 1, awayGoals: 0, over25Pct: 68, homeWinPct: 72, awayWinPct: 18 })],
    OPTS,
  );
  assert.strictEqual(events.length, 1, "one goal event");
  assert.strictEqual(events[0].kind, "goal");
  const t = events[0].text;
  assert.ok(t.includes("GOAL"), "text says GOAL");
  assert.ok(t.includes("1–0"), "text carries the new score");
  assert.ok(t.includes("O2.5 68%"), "text cites Over 2.5");
  assert.ok(t.includes("win 72%"), "text cites the 1X2 leader (home 72%)");
  assert.ok(t.includes("▲"), "text shows odds direction");
  assert.strictEqual(flash["1"], "goal", "goal → gold row flash");
}

// ---- odds swing (no goal): ≥3pp Over-2.5 move → one swing event + up flash ----
{
  const m = seed(row({ homeGoals: 0, awayGoals: 0, over25Pct: 55, homeWinPct: 50, awayWinPct: 30 }));
  const { events, flash } = deriveTickerEvents(
    m,
    [row({ homeGoals: 0, awayGoals: 0, over25Pct: 60, homeWinPct: 50, awayWinPct: 30 })],
    OPTS,
  );
  assert.strictEqual(events.length, 1, "one swing event");
  assert.strictEqual(events[0].kind, "swing");
  assert.ok(events[0].text.includes("O2.5 60%▲"), "swing cites the moved Over 2.5");
  assert.strictEqual(flash["1"], "up", "odds up → up flash");
}

// ---- sub-threshold move (55 → 56) → NO banner, but the row still flashes the tiny move ----
{
  const m = seed(row({ homeGoals: 0, awayGoals: 0, over25Pct: 55 }));
  const { events, flash } = deriveTickerEvents(m, [row({ homeGoals: 0, awayGoals: 0, over25Pct: 56 })], OPTS);
  assert.strictEqual(events.length, 0, "1pp move does not broadcast");
  assert.strictEqual(flash["1"], "up", "but any move still flashes the row arrow");
}

// ---- VAR: score decrease (1-0 → 0-0) fires nothing and re-seeds the baseline silently ----
{
  const m = seed(row({ homeGoals: 1, awayGoals: 0 }));
  const back = deriveTickerEvents(m, [row({ homeGoals: 0, awayGoals: 0 })], OPTS);
  assert.strictEqual(back.events.length, 0, "goal disallowed → no event");
  assert.strictEqual(back.flash["1"], undefined, "no flash on decrease");
  // baseline now 0-0, so a subsequent 0-0 → 1-0 is a fresh goal
  const again = deriveTickerEvents(m, [row({ homeGoals: 1, awayGoals: 0 })], OPTS);
  assert.strictEqual(again.events.length, 1, "baseline re-seeded → next increase is a goal");
}

console.log("test-ticker-events: OK");
