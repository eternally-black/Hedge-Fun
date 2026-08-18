
// ---- Up/Down windows. Two of these can END at the same minute and be different bets entirely: on
// 2026-08-18 the deck served the 5:10-5:15 window at 51/50 (not open yet, an honest coin flip) while
// Polymarket showed the 5:00-5:15 market at 69/32, eleven minutes in. Same countdown, same truncated
// title. The window is the only thing that tells them apart, and the short series is cut outright.
{
  const q5 = "Bitcoin Up or Down - August 18, 5:10PM-5:15PM ET";
  const q15 = "Bitcoin Up or Down - August 18, 5:00PM-5:15PM ET";
  const w5 = upDownWindow(q5);
  const w15 = upDownWindow(q15);
  assert.ok(w5 && w15, "both windows parse");
  assert.strictEqual(w5!.lengthMin, 5);
  assert.strictEqual(w15!.lengthMin, 15);
  assert.strictEqual(w15!.label, "5:00–5:15PM ET", "label carries the window, not just the end");
  assert.strictEqual(upDownWindow("Will BTC hit 100k in 2026?"), null, "not an Up/Down question");

  const end = Date.parse("2026-08-18T21:15:00Z");
  // The five-minute series is out regardless of when you ask — it is a product we have not built.
  assert.strictEqual(servableUpDown(q5, end, end - 60_000), false, "5-min window: never served");
  assert.ok(MIN_UPDOWN_WINDOW_MIN > 5);
  // The fifteen-minute one is served once it has OPENED, and not before.
  assert.strictEqual(servableUpDown(q15, end, end - 16 * 60_000), false, "not open yet");
  assert.strictEqual(servableUpDown(q15, end, end - 11 * 60_000), true, "open, eleven minutes to run");
  // Anything that is not an Up/Down market is unaffected.
  assert.strictEqual(servableUpDown("Arsenal vs Chelsea", end, end - 60_000), true);
  // And the title keeps the market, not the timestamp — the window has its own line now.
  assert.strictEqual(
    displayQuestion({ question: q15, outcomeYesLabel: "Up", outcomeNoLabel: "Down" }),
    "Bitcoin Up or Down",
    "title is the market itself",
  );
}

// Self-check for human-readable Over/Under labels + hint (DB-free, pure).
// Polymarket hands "Over"/"Under" with the line buried in the question; we fold it in.
// Run: npx tsx scripts/test-side-labels.ts
import assert from "node:assert";
import { sideLabels, marketHint, isUpDown, displayQuestion, soccerHint } from "../src/app/ui";
import { upDownWindow, servableUpDown, MIN_UPDOWN_WINDOW_MIN } from "../src/lib/updown";
// The RN port, imported to prove the two clients agree (see the drift check at the bottom). Its only
// import is `import type`, so pulling it in here needs nothing from mobile/node_modules.
import { soccerHint as mobileSoccerHint } from "../mobile/src/format";

const card = (question: string, yes: string, no: string) => ({ question, outcomeYesLabel: yes, outcomeNoLabel: no });

// ---- Over/Under: line pulled from the question, mapped to the right side ----
const a = sideLabels(card("Map 1 Total Rounds: Over/Under 21.5", "Over", "Under"));
assert.deepStrictEqual(a, { yes: "Over 21.5", no: "Under 21.5" }, "Over/Under 21.5 -> labels carry the line");

// O/U shorthand + reversed side order (YES=Under) still maps correctly.
const b = sideLabels(card("Norway vs. France: Norway O/U 0.5", "Under", "Over"));
assert.deepStrictEqual(b, { yes: "Under 0.5", no: "Over 0.5" }, "O/U 0.5 with YES=Under keeps the mapping");

// ---- non-Over/Under: raw labels pass through untouched ----
assert.deepStrictEqual(sideLabels(card("Bosnia vs. Qatar", "Bosnia", "Qatar")), { yes: "Bosnia", no: "Qatar" }, "team labels untouched");
assert.deepStrictEqual(sideLabels(card("Will BTC hit 100k?", "Yes", "No")), { yes: "Yes", no: "No" }, "Yes/No untouched");

// ---- no extractable line: labels unchanged, hint falls back to generic ----
const noLine = sideLabels(card("Total goals over or under?", "Over", "Under"));
assert.deepStrictEqual(noLine, { yes: "Over", no: "Under" }, "no number in question -> raw Over/Under");

// ---- hint: only Over/Under gets one ----
assert.strictEqual(marketHint(card("Map 1 Total Rounds: Over/Under 21.5", "Over", "Under")), "Will the total be over or under 21.5?", "OU hint names the line");
assert.strictEqual(marketHint(card("Bosnia vs. Qatar", "Bosnia", "Qatar")), null, "team market needs no hint");
assert.strictEqual(marketHint(card("Will BTC hit 100k?", "Yes", "No")), null, "Yes/No needs no hint");

// ---- isUpDown: only the crypto Up/Down shape ----
assert.strictEqual(isUpDown(card("Bitcoin Up or Down - 9:05AM", "Up", "Down")), true, "Up/Down -> true");
assert.strictEqual(isUpDown(card("Bosnia vs. Qatar", "Bosnia", "Qatar")), false, "teams -> false");
assert.strictEqual(isUpDown(card("Will BTC hit 100k?", "Yes", "No")), false, "Yes/No -> false");

// ---- displayQuestion: strip the absolute time from Up/Down questions, leave others alone ----
assert.strictEqual(displayQuestion(card("Bitcoin Up or Down - 9:05AM", "Up", "Down")), "Bitcoin Up or Down", "dash + clock stripped");
assert.strictEqual(displayQuestion(card("Ethereum Up or Down - July 1, 3PM ET", "Up", "Down")), "Ethereum Up or Down", "dash + date/zone stripped");
assert.strictEqual(displayQuestion(card("Dogecoin Up or Down 11:30AM", "Up", "Down")), "Dogecoin Up or Down", "bare trailing clock stripped");
assert.strictEqual(displayQuestion(card("Bitcoin Up or Down", "Up", "Down")), "Bitcoin Up or Down", "no time -> unchanged");
assert.strictEqual(displayQuestion(card("Bosnia vs. Qatar at 9:05AM", "Bosnia", "Qatar")), "Bosnia vs. Qatar at 9:05AM", "non-Up/Down untouched (no strip)");

// ---- soccer: the fixed slug-generated jargon becomes a sentence ----
// Questions are verbatim from live Gamma (2026-08-03). Paraphrasing them would let the test pass
// while the real feed still produced jargon.
const hint = (q: string, y = "Over", n = "Under") => marketHint(card(q, y, n));

// The Over/Under grammar: scope (match | 1st | 2nd) x subject (total | a team) x metric (goals | corners).
assert.strictEqual(hint("FK Shakhtar Donetsk vs. FK Kudrivka: O/U 9.5 Total Corners"),
  "Will there be 10 or more corner kicks in the match?", "match corner total");
assert.strictEqual(hint("FK Auda Riga vs. Ogre United: 2nd Half O/U 4.5 Total Corners"),
  "Will there be 5 or more corner kicks in the second half?", "second-half corner total");
// Goals are only claimed when the question PROVES it is football. A bare "A vs. B: O/U 3.5" does
// not: read as goals it produced "4 or more goals" on a tennis card. It now falls back to the
// generic line — vague, but never wrong.
assert.strictEqual(hint("FK Auda Riga vs. Ogre United: O/U 3.5"),
  "Will the total be over or under 3.5?", "bare total proves nothing -> generic line");
assert.strictEqual(hint("Seinajoen JK vs. HJK Helsinki: HJK Helsinki 2nd Half O/U 1.5"),
  "Will the total be over or under 1.5?", "bare team total proves nothing either");
// With proof present (a corners sibling names the sport), goals are safe to name.
assert.strictEqual(hint("Arsenal vs. Spurs (Premier League): O/U 3.5"),
  "Will there be 4 or more goals in the match?", "league word proves football -> goals named");
assert.strictEqual(hint("Seinajoen JK vs. HJK Helsinki: Seinajoen JK O/U 3.5 Corners"),
  "Will Seinajoen JK take 4 or more corner kicks in the match?", "team corner total");
// A subject that matches neither team is not a shape we understand -> stay quiet rather than guess.
assert.strictEqual(hint("A vs. B: Someone Else 1st Half O/U 1.5"),
  "Will the total be over or under 1.5?", "unrecognised subject falls back to the generic line");

// The Yes/No families.
const yn = (q: string) => marketHint(card(q, "Yes", "No"));
assert.strictEqual(yn("FK Shakhtar Donetsk vs. FK Kudrivka: Both Teams to Score"),
  "Will both teams score at least one goal?");
assert.strictEqual(yn("FK Auda Riga vs. Ogre United: Both Teams to Score in First Half"),
  "Will both teams score in the first half?");
// The one that reads wrong if you translate the term instead of the meaning: the second half is
// scored as its own match, so 2-1 at the break finishing 3-2 is a 1-1 second half.
assert.strictEqual(yn("FK Kudrivka vs. FK Shakhtar Donetsk: Second half draw?"),
  "Will both teams score the same number of goals in the second half?");
// Cross-sport SHAPES carry no units: NFL and NBA generate the same slugs, and "win by 2 or more
// goals" on a baseball spread was a real bug found in audit.
assert.strictEqual(marketHint(card("Spread: Boston Red Sox (-1.5)", "Boston Red Sox", "Colorado Rockies")),
  "Will Boston Red Sox win by 2 or more?", "spread wording is unit-free");
assert.strictEqual(yn("Kansas City Chiefs to score first vs. Buffalo Bills?"),
  "Will Kansas City Chiefs score first?", "score-first wording is unit-free");
assert.strictEqual(yn("Boston Celtics to win the second half?"),
  "Will Boston Celtics score more than their opponent in the second half?", "second-half wording is unit-free");
// And a bare total on a non-soccer card must never be read as goals.
assert.strictEqual(hint("Alcaraz vs. Sinner: O/U 3.5"),
  "Will the total be over or under 3.5?", "tennis total is not given a goals sentence");
assert.strictEqual(hint("NAVI vs. FaZe: O/U 2.5"),
  "Will the total be over or under 2.5?", "esports total is not given a goals sentence");
assert.strictEqual(yn("FK Kudrivka vs. FK Shakhtar Donetsk: Draw at halftime?"),
  "Will the score be equal at half-time?");
assert.strictEqual(yn("Will FK Auda Riga vs. Ogre United end in a draw?"),
  "Will the match finish with neither team winning?");
assert.strictEqual(yn("FK Auda Riga vs. Ogre United: Neither team to score first?"),
  "Will the match end with neither team scoring?");
assert.strictEqual(yn("FK Shakhtar Donetsk to score first vs. FK Kudrivka?"),
  "Will FK Shakhtar Donetsk score first?");
assert.strictEqual(yn("FK Auda Riga leading at halftime?"),
  "Will FK Auda Riga be ahead at half-time?");
assert.strictEqual(yn("Ogre United to win the second half?"),
  "Will Ogre United score more than their opponent in the second half?");
assert.strictEqual(yn("Exact Score: FK Shakhtar Donetsk 3 - 0 FK Kudrivka?"),
  "Will the match finish exactly 3-0 to FK Shakhtar Donetsk?");
assert.strictEqual(yn("Exact Score: Any Other Score?"),
  "Will the final score be none of the ones listed?");
assert.strictEqual(marketHint(card("Spread: FK Shakhtar Donetsk (-1.5)", "FK Shakhtar Donetsk", "FK Kudrivka")),
  "Will FK Shakhtar Donetsk win by 2 or more?", "handicap spelled out, the word never shown");
assert.strictEqual(marketHint(card("FK Auda Riga vs. Ogre United: Total Corners Odd or Even?", "Odd", "Even")),
  "Will the total number of corner kicks be an odd or an even number?");

// ---- the bar: no jargon may come back in ----
// Replacing football jargon with commentary-box idiom is not a fix. This is the guard that fails if
// someone "tidies" a hint back into the dialect it was written out of.
const BANNED = /\b(level|outscore|clean sheet|handicap|btts|this team)\b/i;
for (const q of [
  "FK Shakhtar Donetsk vs. FK Kudrivka: O/U 9.5 Total Corners",
  "FK Kudrivka vs. FK Shakhtar Donetsk: Second half draw?",
  "FK Kudrivka vs. FK Shakhtar Donetsk: Draw at halftime?",
  "Ogre United to win the second half?",
  "FK Auda Riga leading at halftime?",
  "Spread: FK Shakhtar Donetsk (-1.5)",
]) {
  const h = marketHint(card(q, "Yes", "No"));
  assert.ok(h, `soccer question must produce a hint: ${q}`);
  assert.ok(!BANNED.test(h!), `hint must avoid insider jargon, got: ${h}`);
}

// Non-soccer markets are untouched by all of the above.
assert.strictEqual(marketHint(card("Map 1 Total Rounds: Over/Under 21.5", "Over", "Under")),
  "Will the total be over or under 21.5?", "esports total keeps the generic hint");
assert.strictEqual(marketHint(card("Panthers vs. Cardinals: O/U 32.5", "Over", "Under")),
  "Will the total be over or under 32.5?", "NFL total is not given a soccer sentence");

// ---- web and mobile must read a card the same way ----
// mobile/src/format.ts is a hand-kept port (it deliberately can't import deck-mix), so the soccer
// grammar exists twice. Types are caught by tsc; LOGIC drift is silent, and a card that says
// different things on the two clients is a support ticket nobody can reproduce. Compare outputs
// over the whole corpus instead of trusting the two files to look alike.
{
  const cases = [
    "FK Shakhtar Donetsk vs. FK Kudrivka: O/U 9.5 Total Corners",
    "FK Auda Riga vs. Ogre United: 2nd Half O/U 4.5 Total Corners",
    "FK Auda Riga vs. Ogre United: O/U 3.5",
    "Seinajoen JK vs. HJK Helsinki: HJK Helsinki 2nd Half O/U 1.5",
    "Seinajoen JK vs. HJK Helsinki: Seinajoen JK O/U 3.5 Corners",
    "A vs. B: Someone Else 1st Half O/U 1.5",
    "Panthers vs. Cardinals: O/U 32.5",
    "FK Shakhtar Donetsk vs. FK Kudrivka: Both Teams to Score",
    "FK Auda Riga vs. Ogre United: Both Teams to Score in First Half",
    "FK Kudrivka vs. FK Shakhtar Donetsk: Second half draw?",
    "FK Kudrivka vs. FK Shakhtar Donetsk: Draw at halftime?",
    "Will FK Auda Riga vs. Ogre United end in a draw?",
    "FK Auda Riga vs. Ogre United: Neither team to score first?",
    "FK Shakhtar Donetsk to score first vs. FK Kudrivka?",
    "FK Auda Riga leading at halftime?",
    "Ogre United to win the second half?",
    "Exact Score: FK Shakhtar Donetsk 3 - 0 FK Kudrivka?",
    "Exact Score: Any Other Score?",
    "Spread: FK Shakhtar Donetsk (-1.5)",
    "FK Auda Riga vs. Ogre United: Total Corners Odd or Even?",
    "Map 1 Total Rounds: Over/Under 21.5",
    "Bosnia vs. Qatar",
    "Alcaraz vs. Sinner: O/U 3.5",
    "NAVI vs. FaZe: O/U 2.5",
    "Boston Celtics leading at halftime?",
    "Kansas City Chiefs to score first vs. Buffalo Bills?",
    "Arsenal vs. Spurs (Premier League): O/U 3.5",
    "A vs. B: O/U 2.25",
    "A vs. B: O/U 3",
  ];
  for (const q of cases) {
    assert.strictEqual(mobileSoccerHint(q), soccerHint(q), `web/mobile soccer hint drift on: ${q}`);
  }
}

console.log("test-side-labels: OK");
