// Self-checks for the pure referral reward logic (DB-free). Run: npx tsx scripts/test-referral.ts
// The DB-backed funcs (computeReferralRewards etc.) need a live DB; the money-sensitive
// arithmetic is extracted into pure helpers, asserted here.
import assert from "node:assert";
import {
  hasQualifyingSwipes,
  inviterAccrualDelta,
  DEFAULT_REWARD_PARAMS,
} from "../src/lib/referral";

// ---- qualify gate (Q7): referral counts only after 10 lifetime swipes ----
assert.strictEqual(hasQualifyingSwipes(9), false, "9 swipes must NOT qualify");
assert.strictEqual(hasQualifyingSwipes(10), true, "10th swipe must qualify");
assert.strictEqual(hasQualifyingSwipes(11), true, "past-threshold stays qualified");

// ---- single-level (Q5): the invitee's own REFERRAL income never feeds the inviter ----
assert.ok(!DEFAULT_REWARD_PARAMS.inviterEligibleTypes.includes("REFERRAL"), "no multi-level");
assert.strictEqual(DEFAULT_REWARD_PARAMS.inviterRate, 0.2, "inviter rate = 20%");

// ---- inviter 20% MUST pay across amount-1 rows (the bug: per-row floor paid 0) ----
const rate = DEFAULT_REWARD_PARAMS.inviterRate;
// 50 single-point rows (swipes + logins) => 20% of 50 = 10, not 0.
assert.strictEqual(inviterAccrualDelta(50, 0, rate), 10, "20% of 50 amount-1 rows = 10 (not 0)");
// Sub-threshold: 4 raw -> floor(0.8) = 0 (correct, no payout yet).
assert.strictEqual(inviterAccrualDelta(4, 0, rate), 0, "4 raw -> floor(0.8) = 0");
// 5 raw -> floor(1) = 1 (first whole point owed).
assert.strictEqual(inviterAccrualDelta(5, 0, rate), 1, "5 raw -> 1");

// ---- idempotency / delta: re-run pays only the new portion ----
// Already paid 10 of the 10 owed at 50 raw -> 0 on re-run.
assert.strictEqual(inviterAccrualDelta(50, 10, rate), 0, "re-run at same raw pays 0");
// Invitee earns 10 more (60 raw) -> owed 12, paid 10 -> delta 2.
assert.strictEqual(inviterAccrualDelta(60, 10, rate), 2, "grew to 60 raw -> delta 2");
// Never negative even if params shrink owed below already-paid.
assert.strictEqual(inviterAccrualDelta(50, 99, rate), 0, "clamp at 0, never claw back");

console.log("referral logic: OK");
