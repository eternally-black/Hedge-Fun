// Offline mapMarket fixtures, moved OUT of the live canary (scripts/verify-polymarket.ts) so a code
// change that breaks them fails `npm test` at merge instead of paging a false "drift" the next day.
// The 2026-08-20 and 2026-09-30 canary red runs were exactly this: our own edits broke these
// fixtures, which only ran in the daily canary.
//
// Also pins the canary's exit classification (isUpstreamUnreachable) so an outage is never paged as
// drift and a real contract problem is never swallowed as an outage.
import assert from "node:assert";
import { mapMarket, GammaStatusError } from "../src/lib/polymarket";
import { isUpstreamUnreachable } from "./canary-exit";

// 3. mapMarket unit: a synthetic resolved-YES market maps correctly.
const synthetic = mapMarket({
  conditionId: "0xtest",
  question: "Test?",
  endDate: new Date(Date.now() + 3_600_000).toISOString(),
  outcomes: '["Yes","No"]',
  outcomePrices: '["1","0"]',
  umaResolutionStatus: "resolved",
  closed: true,
});
assert.strictEqual(synthetic?.status, "RESOLVED");
assert.strictEqual(synthetic?.resolvedOutcome, "YES");
console.log("3. ✓ mapMarket resolves YES on [1,0] + umaResolutionStatus=resolved");

// 3b. startsAt is KICK-OFF only (c61ebbc): Gamma's `gameStartTime` ("+00" wire form normalized
//     to ISO), never `startDate` — that is the LISTING date, often weeks before the match, and
//     it used to masquerade here as a fact about the game. This fixture pins both halves.
const kickoffIso = "2026-07-01T18:00:00.000Z";
const withStart = mapMarket({
  conditionId: "0xstart",
  question: "Will CA Platense win on 2026-07-01?", // a match: only sports/esports keep a kick-off (3ccb6ff)
  startDate: "2026-06-20T00:00:00Z", // listing date — must be IGNORED
  gameStartTime: "2026-07-01 18:00:00+00", // Gamma's own wire format for kick-off
  endDate: new Date(Date.now() + 3_600_000).toISOString(),
  outcomes: '["Yes","No"]',
  outcomePrices: '["0.5","0.5"]',
  tags: [{ label: "Sports" }, { label: "Soccer" }],
});
assert.strictEqual(withStart?.startsAt, kickoffIso, "gameStartTime present -> startsAt = kick-off ISO");
const noStart = mapMarket({
  conditionId: "0xnostart",
  question: "Crypto up or down?",
  startDate: "2026-06-20T00:00:00Z", // a listing date alone is NOT a start
  endDate: new Date(Date.now() + 3_600_000).toISOString(),
  outcomes: '["Up","Down"]',
  outcomePrices: '["0.5","0.5"]',
});
assert.strictEqual(noStart?.startsAt, null, "no gameStartTime -> startsAt = null (startDate ignored)");
console.log("3b. ✓ mapMarket maps startsAt from gameStartTime only (kick-off), never startDate");

// 4. Binary markets keep their REAL side labels (index 0 = YES side, index 1 = NO side).
//    The card shows these, not a forced Yes/No. Covers Up/Down, teams, and Over/Under.
const cases: { label: string; outcomes: string; prices: string; yesL: string; noL: string; yesBp: number; noBp: number }[] = [
  { label: "Up/Down", outcomes: '["Up", "Down"]', prices: '["0.7", "0.3"]', yesL: "Up", noL: "Down", yesBp: 7000, noBp: 3000 },
  { label: "teams", outcomes: '["L1ga Team", "4ikibamboni"]', prices: '["0.625", "0.375"]', yesL: "L1ga Team", noL: "4ikibamboni", yesBp: 6250, noBp: 3750 },
  { label: "Over/Under", outcomes: '["Over", "Under"]', prices: '["0.465", "0.535"]', yesL: "Over", noL: "Under", yesBp: 4650, noBp: 5350 },
];
for (const c of cases) {
  const mk = mapMarket({
    conditionId: "0x" + c.label,
    question: `Binary: ${c.label}?`,
    endDate: new Date(Date.now() + 3_600_000).toISOString(),
    outcomes: c.outcomes,
    outcomePrices: c.prices,
  });
  assert.ok(mk, `${c.label} must map (binary with real labels)`);
  assert.strictEqual(mk!.outcomeYesLabel, c.yesL, `${c.label}: side-A label`);
  assert.strictEqual(mk!.outcomeNoLabel, c.noL, `${c.label}: side-B label`);
  assert.strictEqual(mk!.yesPriceBp, c.yesBp, `${c.label}: side-A price`);
  assert.strictEqual(mk!.noPriceBp, c.noBp, `${c.label}: side-B price`);
}
// Multi-outcome (>2) is still rejected — we don't model n-way bets.
const multi = mapMarket({
  conditionId: "0xmulti", question: "Who wins?",
  endDate: new Date(Date.now() + 3_600_000).toISOString(),
  outcomes: '["A","B","C"]', outcomePrices: '["0.3","0.3","0.4"]',
});
assert.strictEqual(multi, null, "3-way market must be rejected");
console.log("4. ✓ mapMarket keeps real labels for Up/Down, teams, Over/Under; rejects 3-way");

// 5. canary exit classification: an upstream outage must never be paged as drift, and a contract
//    problem (a 4xx, a failed assertion) must never be swallowed as an outage.
const unreachable: [string, unknown][] = [
  ["GammaStatusError 503", new GammaStatusError(503, "/m")],
  ["TimeoutError", Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })],
  ["gamma retry exhausted (the 2026-10-13 page)", new Error("The operation was aborted due to timeout (after 4 attempts)")],
  ["CLOB 502", new Error("CLOB 502")],
  ["CLOB retry exhausted", new Error("CLOB /books failed after 4 attempts: CLOB 503")],
  ["fetch failed + ECONNRESET cause", Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("x"), { code: "ECONNRESET" }) })],
];
for (const [label, e] of unreachable) {
  assert.strictEqual(isUpstreamUnreachable(e), true, `${label} must classify as unreachable`);
}
const drift: [string, unknown][] = [
  ["AssertionError", new assert.AssertionError({ message: "drift" })],
  ["GammaStatusError 404", new GammaStatusError(404, "/m")],
  ["CLOB 404 (not retryable)", new Error("CLOB 404 (not retryable)")],
  ["Gamma 400", new Error("Gamma 400")],
  ["TypeError (not fetch failed)", new TypeError("Cannot read properties of undefined")],
  ["non-Error", "string"],
];
for (const [label, e] of drift) {
  assert.strictEqual(isUpstreamUnreachable(e), false, `${label} must classify as drift`);
}
console.log("5. ✓ canary exit classification: outages -> exit 3, drift -> exit 1");

console.log("map-market: OK");
