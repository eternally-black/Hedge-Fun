// DB-free unit test for the football settlement decision + market-id parser.
import assert from "node:assert";
import { parseTxMarketId, decideOuResolution } from "./settle-football";

// ── parseTxMarketId ──
assert.deepStrictEqual(parseTxMarketId("txline:18172469:OU25"), { fixtureId: 18172469, line: 2.5 });
assert.deepStrictEqual(parseTxMarketId("txline:1:OU15"), { fixtureId: 1, line: 1.5 });
assert.deepStrictEqual(parseTxMarketId("txline:1:OU35"), { fixtureId: 1, line: 3.5 });
assert.strictEqual(parseTxMarketId("0xc0ffee"), null, "polymarket id is not a tx id");
assert.strictEqual(parseTxMarketId("txline:1:OU99"), null, "unknown line kind");
assert.strictEqual(parseTxMarketId("txline:abc:OU25"), null, "non-numeric fixture");

// ── decideOuResolution: Over wins iff total goals > line ──
const ended = { endedPhase: true, abandoned: false, pastDeadline: false };
assert.deepStrictEqual(decideOuResolution({ line: 2.5, home: 2, away: 1, ...ended }), { kind: "resolved", resolvedYes: true }, "3 > 2.5 → Over");
assert.deepStrictEqual(decideOuResolution({ line: 3.5, home: 2, away: 1, ...ended }), { kind: "resolved", resolvedYes: false }, "3 < 3.5 → Under");
assert.deepStrictEqual(decideOuResolution({ line: 2.5, home: 0, away: 0, ...ended }), { kind: "resolved", resolvedYes: false }, "0 < 2.5 → Under");
assert.deepStrictEqual(decideOuResolution({ line: 1.5, home: 1, away: 1, ...ended }), { kind: "resolved", resolvedYes: true }, "2 > 1.5 → Over");

// ── not-ended / no-data guards → stay open ──
assert.deepStrictEqual(decideOuResolution({ line: 2.5, home: 1, away: 0, endedPhase: false, abandoned: false, pastDeadline: false }), { kind: "open" }, "in-play before deadline → open");
assert.deepStrictEqual(decideOuResolution({ line: 2.5, home: null, away: null, endedPhase: true, abandoned: false, pastDeadline: true }), { kind: "open" }, "no score data → never settle (postponed/blank guard)");

// ── abandoned/postponed WITH a partial score → never settle (a 1-0-then-postponed must not resolve Under) ──
assert.deepStrictEqual(decideOuResolution({ line: 2.5, home: 1, away: 0, endedPhase: false, abandoned: true, pastDeadline: true }), { kind: "open" }, "postponed + partial score + past deadline → open");
assert.deepStrictEqual(decideOuResolution({ line: 2.5, home: 1, away: 0, endedPhase: true, abandoned: true, pastDeadline: false }), { kind: "open" }, "abandoned beats a lagging ended phase → open");

// ── time-fallback: past the settle deadline WITH data settles even if the phase still lags ──
assert.deepStrictEqual(decideOuResolution({ line: 2.5, home: 1, away: 0, endedPhase: false, abandoned: false, pastDeadline: true }), { kind: "resolved", resolvedYes: false }, "past deadline + data → settle (1 < 2.5 Under)");

console.log("settle-football: OK");
