// Self-check for the poller's toResolution() — the map from a Polymarket market shape to a
// settlement Resolution. This is the decision that drives whether a bet settles, stays PENDING,
// or voids, and it had NO test (the 2026-06-25 "stuck in Awaiting resolution" bug lived here).
// DB-free: importing poller.ts does not start the daemon (its loop() is guarded to direct-run).
// Run: npx tsx scripts/test-poller-resolution.ts
import assert from "node:assert";
import { toResolution, chainToResolution } from "./poller";
import type { MarketCache } from "../src/lib/polymarket";

const base: MarketCache = {
  polymarketId: "0xtest", question: "q?", category: null,
  outcomeYesLabel: "Yes", outcomeNoLabel: "No",
  yesPriceBp: 5000, noPriceBp: 5000,
  // D10 depth fields: irrelevant to resolution mapping (settlement never quotes), all null.
  yesTokenId: null, noTokenId: null, bestAskBp: null,
  yesEffPriceBp: null, noEffPriceBp: null,
  yesMaxStakeCents: null, noMaxStakeCents: null, bookTsAt: null,
  league: null, startsAt: null, resolutionDeadline: new Date().toISOString(),
  status: "OPEN", resolvedOutcome: null,
};
const mk = (o: Partial<MarketCache>): MarketCache => ({ ...base, ...o });

// Not found / not resolved -> open (re-poll), never a spurious settle.
assert.deepStrictEqual(toResolution(null), { kind: "open" }, "null -> open");
assert.deepStrictEqual(toResolution(mk({ status: "OPEN" })), { kind: "open" }, "OPEN -> open");
assert.deepStrictEqual(toResolution(mk({ status: "CLOSED" })), { kind: "open" }, "CLOSED (UMA dispute window) -> open, re-poll");

// Clean resolution -> settle on the winning side.
assert.deepStrictEqual(toResolution(mk({ status: "RESOLVED", resolvedOutcome: "YES" })), { kind: "resolved", resolvedYes: true }, "resolved YES");
assert.deepStrictEqual(toResolution(mk({ status: "RESOLVED", resolvedOutcome: "NO" })), { kind: "resolved", resolvedYes: false }, "resolved NO");

// DOCUMENTED GAP (deferred void detection): a genuinely void/canceled Polymarket market is not yet
// detected by mapMarket (no explicit void field in the Gamma fields we read), so it currently maps
// to OPEN -> the bet keeps re-polling. Funds are HELD (lockedCents), not lost — but the bet never
// settles until/unless the market resolves cleanly. Real void detection needs the Polymarket void
// signal (API research); once mapMarket sets status CANCELED, toResolution will return {kind:"void"}
// (settleMarket already handles void -> PUSH/refund). This test pins the CURRENT behavior so the
// deferral is explicit, not an accident.
assert.deepStrictEqual(toResolution(mk({ status: "RESOLVED", resolvedOutcome: null })), { kind: "open" }, "resolved-flag-but-no-clean-outcome -> open (void detection deferred)");

// ---- chainToResolution: the fallback that stops a Gamma lag holding paid-out money "awaiting" ----
// Index 0 is YES, index 1 is NO, a payout to both is the invalid/split — and "no verdict yet" must
// stay OPEN, or a market nobody has reported on would settle against whoever is holding it.
assert.deepStrictEqual(chainToResolution("YES"), { kind: "resolved", resolvedYes: true }, "chain YES -> settle YES");
assert.deepStrictEqual(chainToResolution("NO"), { kind: "resolved", resolvedYes: false }, "chain NO -> settle NO");
assert.deepStrictEqual(chainToResolution("INVALID"), { kind: "void" }, "chain [1,1] split -> void");
assert.deepStrictEqual(chainToResolution(null), { kind: "open" }, "nothing reported on chain -> open, re-poll");

console.log("poller toResolution: OK");
