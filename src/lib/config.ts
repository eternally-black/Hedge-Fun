// All economic constants. Product rules, versioned with code (NOT env).
// OPEN values are flagged — when the product answer lands, change it here only.

// ---- Currency / stake (DECIDED) ----
export const START_BALANCE_CENTS = 100_000; // $1000.00
export const STAKE_CENTS = 10_000; // $100.00 fixed per swipe

// ---- Daily caps (DECIDED) ----
export const SWIPE_CAP = 10; // point-earning swipes/day (over-cap allowed, 0 pts)
export const SHARD_DAILY_CAP = 10; // 1 win = 1 shard, max 10/day

// ---- Collectibles (DECIDED) ----
export const SHARDS_PER_ARTIFACT = 20; // 20 shards -> 1 artifact

// ---- Streak (DECIDED) ----
export const RECOVERY_WINDOW_DAYS = 3; // burn -> 3-day recovery window

// ---- Login bonus (OPEN — size unspecified in spec) ----
export const LOGIN_BONUS = 5; // OPEN: raw login points/day. Change here only.

// ---- Referral (amounts DECIDED; cadence/eligibility OPEN — see referral.ts) ----
export const REFERRAL_INVITEE_BONUS = 20; // one-time points to invitee
export const REFERRAL_INVITER_RATE = 0.2; // inviter gets 20% of referral's points
// OPEN: which point types count toward inviter share, one-time vs ongoing, anti-abuse gate.
//       -> ReferralRewardParams in referral.ts, computed retroactively over logged events.

// ---- x2 multiplier (OPEN — trigger + cadence) ----
// The strategy itself lives in src/lib/multiplier.ts. Ships as Identity (no-op).
// OPEN: trigger (7-day streak vs 70 cumulative swipe points) + cadence (one-time vs continuous).
