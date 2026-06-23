// Self-check for the paper P&L formula. Run: npx tsx scripts/test-settle.ts
// Contract: lockedPriceBp is the price of the SIDE BOUGHT (yes-bet -> yes price,
// no-bet -> no price). computePnl returns { payoutCents, pnlCents, won }.
import assert from "node:assert";
import { computePnl } from "./settle";

const S = 10000; // $100 stake

// YES bought at 0.40, resolves YES -> payout 250, pnl +150, won.
let r = computePnl({ side: "YES", stakeCents: S, lockedPriceBp: 4000, resolvedYes: true });
assert.strictEqual(r.payoutCents, 25000, "YES@0.40 win payout = 25000c");
assert.strictEqual(r.pnlCents, 15000, "YES@0.40 win pnl = +15000c");
assert.strictEqual(r.won, true, "YES on YES = won");

// YES bought at 0.40, resolves NO -> lose stake, not won.
r = computePnl({ side: "YES", stakeCents: S, lockedPriceBp: 4000, resolvedYes: false });
assert.strictEqual(r.payoutCents, 0);
assert.strictEqual(r.pnlCents, -S, "YES lose pnl = -stake");
assert.strictEqual(r.won, false);

// NO bought at its own price 0.60, resolves NO -> payout 16667, pnl +6667, won.
r = computePnl({ side: "NO", stakeCents: S, lockedPriceBp: 6000, resolvedYes: false });
assert.strictEqual(r.payoutCents, 16667, "NO@0.60 win payout");
assert.strictEqual(r.pnlCents, 6667, "NO@0.60 win pnl");
assert.strictEqual(r.won, true, "NO on NO = won");

// NO bought at 0.60, resolves YES -> lose stake.
r = computePnl({ side: "NO", stakeCents: S, lockedPriceBp: 6000, resolvedYes: true });
assert.strictEqual(r.pnlCents, -S, "NO lose pnl = -stake");
assert.strictEqual(r.won, false);

// C3: a near-certain winning bet (price ~1.0) is still a WIN even though pnl rounds to ~0.
// At bp=9999, payout = round(10000*10000/9999) = 10001, pnl = +1, won.
r = computePnl({ side: "YES", stakeCents: S, lockedPriceBp: 9999, resolvedYes: true });
assert.strictEqual(r.won, true, "near-certain win is won");
assert.ok(r.pnlCents >= 0, "near-certain win never loses money");
// And bp=10000 (clamped to 9999) -> pnl tiny but positive, still won (not misclassified LOSS).
r = computePnl({ side: "YES", stakeCents: S, lockedPriceBp: 10000, resolvedYes: true });
assert.strictEqual(r.won, true, "bp=10000 clamped still a win, not a loss");

// Favorite (0.90) winning pays little; underdog (0.10) pays big.
const fav = computePnl({ side: "YES", stakeCents: S, lockedPriceBp: 9000, resolvedYes: true });
const dog = computePnl({ side: "YES", stakeCents: S, lockedPriceBp: 1000, resolvedYes: true });
assert.ok(fav.pnlCents < dog.pnlCents, "underdog win pays more than favorite");
assert.strictEqual(fav.pnlCents, 1111, "YES@0.90 win pnl = +1111c");
assert.strictEqual(dog.pnlCents, 90000, "YES@0.10 win pnl = +90000c");

// Edge clamp: extreme prices don't divide-by-zero.
r = computePnl({ side: "YES", stakeCents: S, lockedPriceBp: 0, resolvedYes: true });
assert.ok(Number.isFinite(r.payoutCents) && r.payoutCents > 0, "bp=0 clamped, finite payout");

console.log("settle P&L: OK");
