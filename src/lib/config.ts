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

// ---- Deck freshness (DECIDED) ----
// Nothing with less than this much time left reaches the top of the deck: the deck route won't serve
// it, the client prunes it live, and a swipe on a market this close to resolution is rejected (409).
// Stops a card from resolving (⏱ -> 0:00) before the user reaches/swipes it.
export const DECK_MIN_LEAD_MS = 5 * 60_000; // 5 minutes

// ---- Daily caps (DECIDED) ----
export const SWIPE_CAP = 10; // point-earning swipes/day (over-cap allowed, 0 pts)
export const SHARD_DAILY_CAP = 10; // 1 win = 1 shard, max 10/day (DECK only — feed shards are UNCAPPED)

// ---- Feed (the post-cap "лента") (DECIDED) ----
// Once the SWIPE_CAP is spent, the deck dead-ends; the feed takes over with an endless vertical
// stream of near-coin-flip binary markets. Bets there earn NO points (leaderboard stays scarce) but
// DO earn shards, UNCAPPED (see awardShard bypassCap). Same $10 stake / same Market cache as the deck.
export const FEED_BAND_BP = { min: 3800, max: 6200 }; // near-50% selection band (38–62%) — the one tuning knob
export const FEED_PAGE_SIZE = 25; // markets per /api/feed page (cursor-paginated infinite scroll)

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
// The rule itself lives in src/lib/points.ts (scorePoints — applied at read time).
// DECIDED: trigger = 7-day streak; cadence = one-time per completed 7-day window. Swipe-only.
