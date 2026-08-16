// All economic constants. Product rules, versioned with code (NOT env).
// OPEN values are flagged — when the product answer lands, change it here only.

// ---- Currency / stake (DECIDED) ----
export const START_BALANCE_CENTS = 20_000; // $200.00
export const STAKE_CENTS = 1_000; // $10.00 fixed per swipe
// Real-money funding floor (§6.2): the bridge's floor is ~$3 and MOVED within a single day; below
// it a deposit parks silently and indefinitely. Hard client minimum with margin — never trust the
// advertised number.
export const MIN_DEPOSIT_USD = 5;
// Pessimistic fee fallback when a market's feeInfo is unfetchable (fees.ts): the highest measured
// tier (rate 0.07, exponent 1 — the 2026-08-13 real fill). Overstating shrinks a hedge slightly;
// understating lies on the card.
export const REAL_FEE_FALLBACK_RATE_BP = 700;
export const REAL_FEE_FALLBACK_EXP_MILLI = 1000;

// ---- Top-up (DECIDED) ----
// Cash/Locked model: a swipe locks STAKE_CENTS (Locked = Σ pending stakes); balance is never
// decremented on swipe. Top-up CREDITS balance. 1st top-up free (low-cash gate), then 1 artifact each.
export const TOPUP_GRANT_CENTS = 20_000; // +$200.00 Cash per top-up
export const FREE_TOPUP_CASH_GATE_CENTS = 3_000; // free top-up only enabled when Cash < $30
export const TOPUP_ARTIFACT_COST = 1; // artifacts spent per paid top-up (1 artifact = SHARDS_PER_ARTIFACT shards)
export const ARTIFACT_TOPUP_CASH_GATE_CENTS = 5_000; // artifact top-up only enabled when Cash < $50 (a bail-out for a low balance, not stackable on a full one)

// ---- Deck freshness (DECIDED) ----
// Nothing with less than this much time left reaches the top of the deck: the deck route won't serve
// it, the client prunes it live, and a swipe on a market this close to resolution is rejected (409).
// Stops a card from resolving (⏱ -> 0:00) before the user reaches/swipes it.
export const DECK_MIN_LEAD_MS = 5 * 60_000; // 5 minutes

// Inventory floor. Below this many SERVABLE markets per refresh, the deck is visibly starving and
// the poller alarms (and the daily canary fails). Sized against the loop it has to feed: a user gets
// SWIPE_CAP swipes a day and the client refills at 8 cards remaining, so a pool under ~25 means the
// very first user of the tick can drain it. Existed because prod ran for weeks on ~26 servable
// markets while the poller logged a healthy-looking "refreshed 100" every minute (2026-07-30).
export const DECK_MIN_SERVABLE = 25;

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

// ---- Hedge engine (phase 2 — S1 wallet hedge) ----
// Sizing PERCENTAGES are PRODUCT RULES, not hedge math (spec §2): copy must never claim
// equivalence. Basis points of the holding's current notional (D3: exposure = market value).
// Majors (SOL / wrapped BTC/ETH): 5–10% band → we size at the midpoint. Long-tail SPL aggregate:
// ~3% into a SOL-short PROXY (basis risk — labelled a proxy, not a hedge).
export const HEDGE_MAJOR_PCT_BP = 700; // 7.0% of a major holding's notional (within the 5–10% band)
export const HEDGE_PROXY_PCT_BP = 300; // 3.0% of the aggregate SPL notional → SOL-short proxy
// Absolute clamps on a proposed hedge stake (before the per-user Cash clamp at accept time).
export const HEDGE_MIN_STAKE_CENTS = 100; // $1.00 — below this a hedge is noise; skip the suggestion
export const HEDGE_MAX_STAKE_CENTS = 50_000; // $500.00 — cap any single paper hedge
// A holding worth less than this is dust — never worth a suggestion (avoids $0.03-token spam).
export const HEDGE_MIN_NOTIONAL_CENTS = 500; // $5.00
// A candidate market must resolve at least this far out to be a usable hedge (not seconds away).
export const HEDGE_MIN_LEAD_MS = 30 * 60_000; // 30 minutes
// Accept-time side-price sanity band (F1). The suggestion pipeline already band-filters at DERIVE
// time (matchS1 uses the SAME 1–99% band; S2 uses [S2_SIDE_FLOOR_BP, S2_SIDE_CEIL_BP]; the fallback
// uses the tighter contested gate), so a bad price normally drops out as a 404 stale. This is the
// FINAL gate re-checked against the freshly-read market price at accept time: it closes the TOCTOU
// window where a poller price refresh lands a decided/collapsed (~99.5/0.5) price between the
// re-derivation read and the price lock — an out-of-band lock -> 409, never a silent snipe. Kept
// equal to the widest matcher band so it never contradicts a legitimately-shown suggestion.
export const HEDGE_ACCEPT_SIDE_FLOOR_BP = 100; // 1% — below this the locked side is degenerate/decided
export const HEDGE_ACCEPT_SIDE_CEIL_BP = 9900; // 99% — above this the locked side is degenerate/decided
// WalletSnapshot TTL. Birdeye wallet APIs are beta-capped (5 rps / 75 rpm, D4) → the snapshot is a
// mandatory cache; NEVER call Birdeye synchronously per request while a fresh snapshot exists.
export const WALLET_SNAPSHOT_TTL_MS = 6 * 3_600_000; // 6h — exposure (Helius+Jupiter) refresh window
export const WALLET_PNL_TTL_MS = 6 * 3_600_000; // 6h — Birdeye avg-cost refresh window (separate, slower)

// ---- Hedge engine (phase 2 — S2 life-event hedge) ----
// S2 has NO position notional to size against (you SUPPORT a team; there is no holding value), so
// the stake is a FIXED product rule — not a percentage. Defaults to the standard swipe stake ($10).
export const HEDGE_S2_STAKE_CENTS = STAKE_CENTS; // $10.00 fixed per life-event hedge
// Deterministic match confidence (0..1) at/above which a free-text match is trusted. Below it we
// fall to the NLU edge (D2), then to the discovery fallback. Tuned so exact/alias/strong-substring
// pass and weak partials defer to the LLM (see src/lib/hedge/s2match.ts).
export const S2_CONFIDENCE_THRESHOLD = 0.55;
// A market is S2-eligible only if BOTH sides price within [floor, ceil] bp. WIDER than the deck's
// 15–85% contested band: a pre-match heavy favourite (a cheap, high-value hedge) must stay; only a
// live/decided price collapse (~99.5/0.5) is dropped. (The FALLBACK path uses the tighter deck gate.)
export const S2_SIDE_FLOOR_BP = 200; // 2%
export const S2_SIDE_CEIL_BP = 9800; // 98%
// Discovery fallback: N random open CONTESTED markets when nothing matches. Labelled discovery in
// the response (is_discovery), NEVER presented as a hedge (spec §2). Bounded pool keeps accept
// re-derivation cheap + deterministic (the shown 3 are a random subset of the same pool).
export const HEDGE_FALLBACK_COUNT = 3;
export const HEDGE_FALLBACK_POOL_MAX = 300; // cap the contested pool scanned for the fallback

// ---- Depth-aware pricing (phase 2 — D10 Slice A) ----
// Two DELIBERATELY different thresholds. QUOTE_TOLERANCE is a fairness guarantee on ONE bet: how far
// the executed price may drift from the quote the user saw before the bet is rejected (seen-vs-
// executed). DEPTH_SLIPPAGE_CAP is a TRADABILITY floor: whether a market's book is real enough for a
// card to exist at all (deck/feed eligibility). Fairness per-bet is tight; the existence floor is
// looser so a thin-but-honest book still gets a card. Different purposes, deliberately different
// numbers — do not "unify" them.
export const QUOTE_TOLERANCE_BP = 200; // 2% relative: seen-vs-executed fairness on ONE bet
export const QUOTE_TOLERANCE_FLOOR_BP = 25; // absolute floor, so a cheap side doesn't 409 on one tick
export const DEPTH_SLIPPAGE_CAP_BP = 500; // 5% relative: deck/feed TRADABILITY floor — deliberately looser
export const DEPTH_SLIPPAGE_FLOOR_BP = 100; // absolute floor for the same (1¢ of wiggle on a cheap side)
// CLOB book cache (src/lib/clob.ts). TTL is only a fetch-throttle — the cache NEVER decides what is
// fresh enough to USE; that policy lives in the callers (BOOK_MAX_STALE_MS at bet-lock time).
export const BOOK_CACHE_TTL_MS = 3_000;
export const BOOK_MAX_STALE_MS = 30_000; // pre-Privy: refuse to LOCK a bet against a book older than this
// Two deliberately different freshness bounds on the same bookTsAt. LOCKING is strict (30s, above):
// the price a bet books at must come from a just-read book. DISPLAYING is looser (10min): a card may
// show a slightly-stale but REAL book price — the poller refreshes the deck every 60s and the hedge
// index every ~5min, so this only binds when refresh is wedged — but never an unbounded one, or a
// dead poller would serve days-old prices as if live. Swapping the two would be wrong both ways:
// locking at the display bound books bets off walked books; displaying at the lock bound empties the
// deck on any transient CLOB wobble.
export const BOOK_MAX_DISPLAY_STALE_MS = 10 * 60_000; // drop a POLYMARKET card whose book read is older than this

// ---- Live card quotes (phase 2 — D10 Slice B) ----
// The client polls ONLY the card(s) it can see — in practice the top one. Next-up cards are cold-
// rendered from the stored book price and get a live quote the moment they reach the top: their
// price is irrelevant until then, so polling them is spend without a scenario.
export const QUOTE_POLL_MS = 3_000; // top-card cadence; books churn ~every 5s, so this tracks them
export const QUOTES_MAX_IDS = 4; // per request — the visible card plus headroom, not a bulk feed
export const QUOTES_RATE_PER_MIN = 60; // 3s polling = 20/min; the rest is headroom for other surfaces
