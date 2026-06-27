// All economic constants. Product rules, versioned with code (NOT env).
// OPEN values are flagged — when the product answer lands, change it here only.

// ---- Currency / stake (DECIDED) ----
export const START_BALANCE_CENTS = 20_000; // $200.00
export const STAKE_CENTS = 1_000; // $10.00 fixed per swipe

// ---- Top-up (DECIDED) ----
// Cash/Locked model: a swipe locks STAKE_CENTS (Locked = Σ pending stakes); balance is never
// decremented on swipe. Top-up CREDITS balance. 1st top-up free (low-cash gate), then 1 artifact each.
export const TOPUP_GRANT_CENTS = 20_000; // +$200.00 Cash per top-up
export const FREE_TOPUP_CASH_GATE_CENTS = 3_000; // free top-up only enabled when Cash < $30
export const TOPUP_ARTIFACT_COST = 1; // artifacts spent per paid top-up (1 artifact = SHARDS_PER_ARTIFACT shards)

// ---- Points top-up (DORMANT — backend only, no UI, flag OFF) ----
// Spend points for Cash. Built but not shipped; flip the flag + set a real cost when the partner agrees.
export const TOPUP_POINTS_ENABLED = false;
export const TOPUP_POINTS_COST = 0; // TODO(pricing): real N points for +$200. Placeholder — never ship enabled with 0.

// ---- Daily caps (DECIDED) ----
export const SWIPE_CAP = 10; // point-earning swipes/day (over-cap allowed, 0 pts)
export const SHARD_DAILY_CAP = 10; // 1 win = 1 shard, max 10/day
export const FREE_SKIPS_PER_DAY = 1; // first skip/day free; each subsequent costs SKIP_SHARD_COST
export const SKIP_SHARD_COST = 1; // shards spent per paid skip (blocked if balance < cost)

// ---- Collectibles (DECIDED) ----
export const SHARDS_PER_ARTIFACT = 20; // 20 shards -> 1 artifact

// ---- Streak (DECIDED) ----
export const RECOVERY_WINDOW_DAYS = 3; // burn -> 3-day recovery window

// ---- Login bonus (DECIDED) ----
export const LOGIN_BONUS = 1; // raw login (GM tap) points/day. Change here only.

// ---- Referral (DECIDED) ----
export const REFERRAL_INVITEE_BONUS = 20; // one-time points to invitee
export const REFERRAL_INVITER_RATE = 0.2; // inviter gets 20% of referral's points
// DECIDED: inviter earns 20% of ALL the invitee's directly-earned points (SWIPE + LOGIN),
//          ongoing forever, counted only after the invitee qualifies (10 lifetime swipes).
//          Single-level only: the invitee's own REFERRAL income is excluded (see referral.ts).
//       -> ReferralRewardParams in referral.ts, computed retroactively over logged events.

// ---- x2 multiplier (DECIDED) ----
// The strategy itself lives in src/lib/multiplier.ts (ACTIVE = SevenDayWindowOneTime).
// DECIDED: trigger = 7-day streak; cadence = one-time per completed 7-day window. Swipe-only.
