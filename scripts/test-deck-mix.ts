// Self-check for deck mixing: never >2 same-category in a row, and the mix is random.
// Run: npx tsx scripts/test-deck-mix.ts
import assert from "node:assert";
import { shuffleNoRun, categoryOf, MAX_RUN } from "../src/lib/deck-mix";

// ---- categoryOf: real shapes (verified live) bucket correctly ----
assert.strictEqual(categoryOf({ question: "Bitcoin Up or Down - 9:05AM", outcomeYesLabel: "Up", outcomeNoLabel: "Down" }), "crypto");
assert.strictEqual(categoryOf({ question: "Games Total: O/U 2.5", outcomeYesLabel: "Over", outcomeNoLabel: "Under" }), "overunder");
assert.strictEqual(categoryOf({ question: "Dota 2: L1ga Team vs 4ikibamboni", outcomeYesLabel: "L1ga Team", outcomeNoLabel: "4ikibamboni" }), "esports");
assert.strictEqual(categoryOf({ question: "Bosnia vs. Qatar match", outcomeYesLabel: "Bosnia", outcomeNoLabel: "Qatar" }), "sports");

// helper: longest run of equal categories in a sequence
function longestRun(cats: string[]): number {
  let best = 0, run = 0, last: string | null = null;
  for (const c of cats) { run = c === last ? run + 1 : 1; last = c; best = Math.max(best, run); }
  return best;
}

// ---- the rule: no >MAX_RUN consecutive same-category, even when one category dominates ----
{
  // 40 crypto + 4 sports + 4 esports: a heavily skewed pool (the real situation).
  const pool = [
    ...Array.from({ length: 40 }, (_, i) => ({ id: "c" + i, cat: "crypto" })),
    ...Array.from({ length: 4 }, (_, i) => ({ id: "s" + i, cat: "sports" })),
    ...Array.from({ length: 4 }, (_, i) => ({ id: "e" + i, cat: "esports" })),
  ];
  // Across many seeds, the run rule holds whenever it's satisfiable.
  for (let seed = 1; seed <= 50; seed++) {
    const out = shuffleNoRun(pool, (x) => x.cat, 20, seed);
    const run = longestRun(out.map((x) => x.cat));
    // With this much crypto, runs of crypto are unavoidable past the point sports/esports run
    // out, but never WHILE other categories remain. We assert the achievable bound: the rule
    // is honored until the minority categories are exhausted. Concretely: the first
    // (sports+esports)*（MAX_RUN+1) positions must never exceed MAX_RUN. Simpler robust check:
    // the run rule is satisfiable here (8 non-crypto can break 20 into <=2-runs), so assert it.
    assert.ok(run <= MAX_RUN, `seed ${seed}: run ${run} exceeds MAX_RUN ${MAX_RUN}`);
  }
}

// ---- balanced pool: rule trivially holds, output length respected ----
{
  const pool = ["a","a","a","b","b","b","c","c","c"].map((cat, i) => ({ id: i, cat }));
  const out = shuffleNoRun(pool, (x) => x.cat, 9, 7);
  assert.strictEqual(out.length, 9, "emits all when limit >= pool");
  assert.ok(longestRun(out.map((x) => x.cat)) <= MAX_RUN, "balanced: <=2 in a row");
}

// ---- randomness: different seeds produce different orders ----
{
  const pool = Array.from({ length: 30 }, (_, i) => ({ id: i, cat: ["crypto","sports","esports"][i % 3] }));
  const a = shuffleNoRun(pool, (x) => x.cat, 30, 11).map((x) => x.id).join(",");
  const b = shuffleNoRun(pool, (x) => x.cat, 30, 99).map((x) => x.id).join(",");
  assert.notStrictEqual(a, b, "different seeds -> different order");
}

console.log("deck mix: OK");
