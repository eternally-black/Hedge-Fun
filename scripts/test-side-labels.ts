// Self-check for human-readable Over/Under labels + hint (DB-free, pure).
// Polymarket hands "Over"/"Under" with the line buried in the question; we fold it in.
// Run: npx tsx scripts/test-side-labels.ts
import assert from "node:assert";
import { sideLabels, marketHint, isUpDown, displayQuestion } from "../src/app/ui";

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

console.log("test-side-labels: OK");
