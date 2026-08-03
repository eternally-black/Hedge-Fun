// Self-check for deck mixing: never >2 same-category in a row, and the mix is random.
// Run: npx tsx scripts/test-deck-mix.ts
import assert from "node:assert";
import { shuffleNoRun, categoryOf, gameOf, isContextPoor, isVagueEsports, MAX_RUN, withinCategoryHorizon, DECK_HORIZON_HOURS } from "../src/lib/deck-mix";

// ---- categoryOf: real shapes (verified live) bucket correctly ----
assert.strictEqual(categoryOf({ question: "Bitcoin Up or Down - 9:05AM", outcomeYesLabel: "Up", outcomeNoLabel: "Down" }), "crypto");
assert.strictEqual(categoryOf({ question: "Games Total: O/U 2.5", outcomeYesLabel: "Over", outcomeNoLabel: "Under" }), "overunder", "bare total, no subject -> overunder");
assert.strictEqual(categoryOf({ question: "Dota 2: L1ga Team vs 4ikibamboni", outcomeYesLabel: "L1ga Team", outcomeNoLabel: "4ikibamboni" }), "esports");
assert.strictEqual(categoryOf({ question: "Bosnia vs. Qatar match", outcomeYesLabel: "Bosnia", outcomeNoLabel: "Qatar" }), "sports");
// THEME beats bet-TYPE: an Over/Under market with a recognizable subject goes to its theme, not "overunder".
assert.strictEqual(categoryOf({ question: "Map 1 Total Rounds: Over/Under 21.5", outcomeYesLabel: "Over", outcomeNoLabel: "Under" }), "esports", "CS2 map total -> esports, not overunder");
assert.strictEqual(categoryOf({ question: "Norway vs. France: Norway O/U 0.5", outcomeYesLabel: "Over", outcomeNoLabel: "Under" }), "sports", "match total -> sports, not overunder");
assert.strictEqual(categoryOf({ question: "Will BTC close over 100k?", outcomeYesLabel: "Over", outcomeNoLabel: "Under" }), "crypto", "crypto total -> crypto, not overunder");

// ---- isContextPoor: bare Over/Under totals with no match named are dropped from the deck ----
const ou = (q: string) => ({ question: q, outcomeYesLabel: "Over", outcomeNoLabel: "Under" });
assert.strictEqual(isContextPoor(ou("Games Total: O/U 4.5")), true, "bare total, no match -> poor");
assert.strictEqual(isContextPoor(ou("Map 1 Total Rounds: Over/Under 21.5")), true, "esports signal but no match named -> poor");
assert.strictEqual(isContextPoor(ou("Norway vs. France: Norway O/U 0.5")), false, "names the match -> usable");

// ---- isVagueEsports: esports with no identifiable game is dropped; recognized games + sports stay ----
const em = (q: string, yes: string, no: string) => ({ question: q, outcomeYesLabel: yes, outcomeNoLabel: no });
assert.strictEqual(isVagueEsports(em("Map 1 Rounds Handicap: Millennium Esports (-6.5) vs Alpha Dominion Nation (+6.5)", "Millennium Esports", "Alpha Dominion Nation")), true, "esports, no recognizable game -> vague (dropped)");
assert.strictEqual(isVagueEsports(em("Dota 2: L1ga Team vs 4ikibamboni", "L1ga Team", "4ikibamboni")), false, "esports with a named game (Dota 2) -> kept");
assert.strictEqual(isVagueEsports(em("Bosnia vs. Qatar match", "Bosnia", "Qatar")), false, "sports (not esports) -> kept");
assert.strictEqual(isVagueEsports(em("Bitcoin Up or Down - 9:05AM", "Up", "Down")), false, "crypto -> kept");
// "Map Handicap" CS2-style series markets: "map" is an esports bet term, so they classify esports —
// with unknown teams/game gameOf is null -> vague -> hidden (the reported "SPORTS: Map Handicap" bug).
assert.strictEqual(categoryOf(em("Map Handicap: Entropy (-1.5) vs SAW (+1.5)", "SAW", "Entropy")), "esports", "map handicap -> esports, not sports");
assert.strictEqual(isVagueEsports(em("Map Handicap: Entropy (-1.5) vs SAW (+1.5)", "SAW", "Entropy")), true, "map handicap + unknown teams -> vague (dropped)");
assert.strictEqual(isVagueEsports(em("CS2 Map Handicap: NAVI (-1.5) vs FaZe (+1.5)", "NAVI", "FaZe")), false, "map handicap + named game (CS2) -> kept, not over-hidden");
assert.strictEqual(isContextPoor(ou("Lakers @ Celtics: Total Points O/U 210.5")), false, "@ match form -> usable");
// non-Over/Under markets are never poor — a team name or Yes/No explains itself.
assert.strictEqual(isContextPoor({ question: "Games Total 4.5", outcomeYesLabel: "Bosnia", outcomeNoLabel: "Qatar" }), false, "named teams -> never poor");
assert.strictEqual(isContextPoor({ question: "Will BTC hit 100k?", outcomeYesLabel: "Yes", outcomeNoLabel: "No" }), false, "Yes/No -> never poor");

// ---- gameOf: name the specific league/game for sports/esports; null otherwise ----
const mk = (q: string, y = "", n = "") => ({ question: q, outcomeYesLabel: y, outcomeNoLabel: n });
// esports games (named-binary carries the signal in labels too)
assert.strictEqual(gameOf(mk("Dota 2: L1ga Team vs 4ikibamboni", "L1ga Team", "4ikibamboni")), "Dota 2");
assert.strictEqual(gameOf(mk("CS2: NAVI vs FaZe", "NAVI", "FaZe")), "CS2");
assert.strictEqual(gameOf(mk("Map 1 Total Rounds: Over/Under 21.5 (Valorant)", "Over", "Under")), "Valorant");
assert.strictEqual(gameOf(mk("LoL Worlds: T1 vs GenG", "T1", "GenG")), "LoL");
// sports leagues
assert.strictEqual(gameOf(mk("NBA: Lakers @ Celtics", "Lakers", "Celtics")), "NBA");
assert.strictEqual(gameOf(mk("UFC 300: Jones vs Aspinall", "Jones", "Aspinall")), "UFC");
assert.strictEqual(gameOf(mk("Soccer: Bosnia vs. Qatar", "Bosnia", "Qatar")), "Soccer", "soccer word -> Soccer");
assert.strictEqual(gameOf(mk("Premier League: Arsenal vs Spurs", "Arsenal", "Spurs")), "Soccer", "league name -> Soccer");

// Real Polymarket soccer names no league at all — the league is only in the slug, which we never see.
// These are verbatim live questions (2026-08-03); before the bet-vocabulary rule every one of them
// badged as a generic "Sports" and lost the pitch art. Keep them REAL: a paraphrase would pass while
// the actual feed still failed.
const soccer = (q: string, y = "Over", n = "Under") =>
  assert.strictEqual(gameOf(mk(q, y, n)), "Soccer", `live soccer shape -> Soccer: ${q}`);
soccer("FSK Bukovyna Chernivtsi vs. FK LNZ Cherkasy: O/U 9.5 Total Corners");
soccer("Celtic FC vs. Dundee FC: Dundee FC O/U 3.5 Corners");
soccer("FK Auda Riga vs. Ogre United: Both Teams to Score in First Half", "Yes", "No");
soccer("FK Kudrivka vs. FK Shakhtar Donetsk: Second half draw?", "Yes", "No");
soccer("Will FK Auda Riga vs. Ogre United end in a draw?", "Yes", "No");
soccer("Exact Score: FK Shakhtar Donetsk 3 - 0 FK Kudrivka?", "Yes", "No");
soccer("FK Panevezys vs. Dziugas: Dziugas 1st Half O/U 0.5");
soccer("Seinajoen JK vs. HJK Helsinki: HJK Helsinki O/U 2.5"); // bare goal total, inside the bound

// The reverse bug this fixes: cricket used to be claimed by the soccer row's "premier league" token.
assert.strictEqual(
  gameOf(mk("Kuwait Kerala Premier League T20: Palakad Patriots vs Blasters Cochin", "Palakad Patriots", "Blasters Cochin")),
  "Cricket",
  "T20 is cricket, even though the name contains 'Premier League'",
);

// The bare-O/U line bound is load-bearing: NFL/NBA/MLB totals name no sport either, and without the
// bound they matched the soccer row. Any of these regressing means the deck badges other sports as
// football and paints them with a pitch.
assert.strictEqual(gameOf(mk("Panthers vs. Cardinals: O/U 32.5", "Over", "Under")), null, "NFL total is not soccer");
assert.strictEqual(gameOf(mk("Lakers @ Celtics: Total Points O/U 210.5", "Over", "Under")), null, "NBA total is not soccer");
assert.strictEqual(gameOf(mk("Yankees vs. Red Sox: O/U 8.5", "Over", "Under")), null, "MLB total is not soccer");
assert.strictEqual(gameOf(mk("Rangers vs. Bruins: O/U 5.5", "Over", "Under")), null, "NHL goal total sits above the bound");
// recognized sport but no specific league word -> null (caller shows generic "Sports")
assert.strictEqual(gameOf(mk("Spread: Team A (-1.5)", "Team A", "Team B")), null, "bare spread, no league -> null");
assert.strictEqual(gameOf(mk("Bosnia vs. Qatar match", "Bosnia", "Qatar")), null, "bare match, no league word -> null (falls back to Sports)");
// non sports/esports categories never name a game
assert.strictEqual(gameOf(mk("Bitcoin Up or Down", "Up", "Down")), null, "crypto -> null");
assert.strictEqual(gameOf(mk("Will the Fed cut rates?", "Yes", "No")), null, "politics -> null");

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

// ---- withinCategoryHorizon: per-category resolution window (crypto/OU blitz, sports/esports longer) ----
{
  const now = 1_000_000_000_000; // fixed clock
  const h = (n: number) => now + n * 3_600_000;
  const crypto = { question: "Bitcoin Up or Down", outcomeYesLabel: "Up", outcomeNoLabel: "Down" };
  const match = { question: "Bosnia vs. Qatar", outcomeYesLabel: "Bosnia", outcomeNoLabel: "Qatar" };
  // Crypto is capped tight: 23h in-window, 30h out (and < DECK_HORIZON_HOURS.sports so the leash differs).
  assert.strictEqual(withinCategoryHorizon(crypto, h(23), now), true, "crypto 23h within 24h horizon");
  assert.strictEqual(withinCategoryHorizon(crypto, h(30), now), false, "crypto 30h beyond 24h horizon");
  // Same 30h deadline is KEPT for a sports match (longer leash) — this is the diversity fix.
  assert.strictEqual(withinCategoryHorizon(match, h(30), now), true, "sports 30h within its longer horizon");
  assert.strictEqual(withinCategoryHorizon(match, h(DECK_HORIZON_HOURS.sports + 1), now), false, "sports beyond its horizon dropped");
  assert.ok(DECK_HORIZON_HOURS.crypto < DECK_HORIZON_HOURS.sports, "crypto horizon is tighter than sports");
}

console.log("deck mix: OK");
