// DB-free unit test for the pure alert decision (alertTierBp). Every branch that must NOT fire is
// pinned here, because a false positive is a notification about nothing.
// Run: npx tsx scripts/test-stock-alerts.ts
import assert from "node:assert";
import { alertTierBp, type AlertInput } from "../src/lib/stock-alerts";

const NOW = new Date("2026-09-14T12:00:00.000Z");
const fresh = new Date(NOW.getTime() - 60_000); // 1 min old — inside the staleness bound

function input(over: Partial<AlertInput> = {}): AlertInput {
  return {
    pnlCents: 0,
    costCents: 10_000,
    currentTierBp: 0,
    pricedAt: fresh,
    halted: false,
    walletCheckedAt: null,
    mode: "PAPER",
    now: NOW,
    ...over,
  };
}

// ---- tier boundaries ----
assert.strictEqual(alertTierBp(input({ pnlCents: 199 })), 0, "+1.99% -> no tier");
assert.strictEqual(alertTierBp(input({ pnlCents: 200 })), 200, "+2% -> 200");
assert.strictEqual(alertTierBp(input({ pnlCents: 700 })), 500, "+7% -> 500");
assert.strictEqual(alertTierBp(input({ pnlCents: 1_200 })), 1_000, "+12% -> 1000");

// ---- monotonic: a tier already fired is never re-fired, a higher one still fires ----
assert.strictEqual(alertTierBp(input({ pnlCents: 700, currentTierBp: 500 })), 0, "current 500 & +7% -> 0");
assert.strictEqual(alertTierBp(input({ pnlCents: 1_200, currentTierBp: 500 })), 1_000, "current 500 & +12% -> 1000");

// ---- a loss is not a profit alert ----
assert.strictEqual(alertTierBp(input({ pnlCents: -500 })), 0, "loss -> 0");

// ---- the floor: +20% of a $1 lot is 20 cents, not news ----
assert.strictEqual(alertTierBp(input({ costCents: 100, pnlCents: 20 })), 0, "+20% but 20c -> 0 (floor)");

// ---- staleness ----
assert.strictEqual(
  alertTierBp(input({ pnlCents: 1_200, pricedAt: new Date(NOW.getTime() - 6 * 60_000) })),
  0,
  "pricedAt 6 min old -> 0",
);
assert.strictEqual(alertTierBp(input({ pnlCents: 1_200, pricedAt: null })), 0, "pricedAt null -> 0");

// ---- halted ----
assert.strictEqual(alertTierBp(input({ pnlCents: 1_200, halted: true })), 0, "halted -> 0");

// ---- no cost basis ----
assert.strictEqual(alertTierBp(input({ pnlCents: 1_200, costCents: 0 })), 0, "cost 0 -> 0");

// ---- REAL lots need a recent wallet reconciliation ----
assert.strictEqual(
  alertTierBp(input({ pnlCents: 1_200, mode: "REAL", walletCheckedAt: null })),
  0,
  "REAL with walletCheckedAt null -> 0",
);
assert.strictEqual(
  alertTierBp(input({ pnlCents: 1_200, mode: "REAL", walletCheckedAt: new Date(NOW.getTime() - 7 * 3_600_000) })),
  0,
  "REAL with walletCheckedAt 7h old -> 0",
);
assert.strictEqual(
  alertTierBp(input({ pnlCents: 500, mode: "REAL", walletCheckedAt: new Date(NOW.getTime() - 3_600_000) })),
  500,
  "REAL with walletCheckedAt 1h old and +5% -> 500",
);

console.log("test-stock-alerts: OK");
