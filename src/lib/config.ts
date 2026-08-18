// All economic constants. Product rules, versioned with code (NOT env).
// OPEN values are flagged — when the product answer lands, change it here only.

// ---- Currency / stake (DECIDED) ----
export const START_BALANCE_CENTS = 20_000; // $200.00
export const STAKE_CENTS = 1_000; // $10.00 fixed per swipe
// Real-money funding floor (§6.2): the bridge's floor is ~$3 and MOVED within a single day; below
// it a deposit parks silently and indefinitely. Hard client minimum with margin — never trust the
// advertised number.
export const MIN_DEPOSIT_USD = 5;
// Applied to EVERY chain, over the top of whatever the bridge advertises. Measured 2026-08-17: the
// bridge's /supported-assets says $2 on most chains and $5 on Ethereum, but the real Solana floor
// was $3 — the advertised number is not the number that clears. Bitcoin and Tron ($7 floors) are
// not offered at all, so "$5 everywhere" is literally true for the chains we show.
export const DEPOSIT_FLOOR_USD = 5;

// ---- Real-money stake (DECIDED: user-configurable, floor $1) ----
// The stake IS the order (owner, 2026-08-17, reversing the earlier all-in reading): the platform fee
// rides on top of it out of the free balance, so a $1 swipe posts a $1 order and debits about $1.04.
// Taking the fee out of the stake instead made a $1 swipe post $0.96, which is under Polymarket's own
// minimum for a marketable buy — the product's floor was unbuyable by construction. Paper keeps its
// fixed STAKE_CENTS above; the two are deliberately separate numbers because one is a game rule and
// the other is somebody's money.
export const REAL_MIN_STAKE_CENTS = 100; // $1.00 floor — Polymarket takes a $1 market buy at any price
// The exchange's OWN floor on a marketable BUY, in micro-USD, and it applies to the order's own
// amount — not to what the user set aside. Learned from a live refusal on 2026-08-17: a $1 stake
// with the fee taken out of it posted $0.96 and came back "invalid amount for a marketable BUY
// order ($0.96), min size: 1". The fee now rides on top of the stake, so the order is the whole
// dollar; this constant is the belt that stops a thin book (which can leave the walk short of the
// stake) from sending an unpostable amount to a device that has to sign it first.
export const REAL_MIN_ORDER_MICRO = 1_000_000n;
// The share granularity the signer actually rounds to: TWO decimals, i.e. 10_000 micro-shares.
// Measured on a real close, and the first measurement was wrong by a factor of a hundred: a BUY
// carried takerAmount 2_040_900 (four decimals) so this said 100, but the SELL that followed asked
// for 1.3333 shares and signed 1.33 — the collateral side of a buy can be finer than the SIZE the
// exchange accepts. Two decimals is the binding one.
// It matters twice on the EXIT path. A sell is FLOORED to it, so the signed order can never exceed
// the position (our own validator refuses that as over_position, which would trap someone in a
// position they asked to close). And a remainder SMALLER than it is unsellable by construction —
// with the wrong value here, 0.003332 shares read as a live position, kept offering a Close button
// that could only produce an empty order, and left an ISSUED intent wedging the market.
export const SHARE_TICK_MICRO = 10_000n;
// How far the EXECUTION price may sit above the price we quoted, before the exchange simply refuses
// to fill. A bound pinned to the book we saw is a bound that misses: on an in-play market the ask
// moved 0.82 → 0.88 while the device was signing, and the order came back "no orders found to match
// with FAK order" with the money untouched but the swipe wasted.
// This costs the user SHARES, never dollars: the order's collateral is the stake and the fee rides
// on top, so a worse fill buys less rather than spending more. Five percent is the alpha default —
// it covers ordinary in-play churn on a 1¢-tick book. Tighten it and swipes fail on fast markets;
// widen it and a thin book fills further up the ladder than the card implied.
export const REAL_SLIPPAGE_BP = 500;
export const REAL_MAX_STAKE_CENTS = 100_000; // $1,000 — a fat-finger bound, not a policy limit
export const REAL_DEFAULT_STAKE_CENTS = 100; // $1.00
// The quick choices in the stake sheet. They SET the amount rather than adding to it — four values
// is the whole useful range for a swipe deck, and anything else goes in the input beside them.
export const REAL_STAKE_PRESETS_CENTS = [100, 200, 500, 1_000] as const;
// Books advertise `min_order_size: 5` — uniformly 5 on every market sampled (2026-08-17), including
// ones whose expensive side sits at 95c, where 5 shares would cost $4.78. Polymarket's own ticket
// nevertheless accepts a $1 market buy on a 99.7c side (~1.003 shares), so the field does not govern
// TAKER buys; it reads as a maker/limit constraint. We therefore gate BUY on the dollar floor above
// and let the exchange be the authority on its own minimum — a rejection there is loud and moves no
// money, whereas enforcing 5 shares here would make a $1 stake impossible on most of the deck.
// Confirmed by a real fill: 1.333332 shares bought as a taker on a book advertising 5. The SELL side
// no longer enforces it either — the first real position was 1.33 shares, and refusing to close what
// the same rule let someone open would trap the money until resolution.
export const REAL_MIN_ORDER_SHARES = 5;
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
export const BOOK_CACHE_TTL_MS = 1_000;
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
export const QUOTE_POLL_MS = 1_000; // top-card cadence. An in-play book moves several times a
// second — measured 0.82 → 0.88 in six seconds on a live match — so a three-second card was showing
// a price the exchange had already left. This only fixes what the user SEES before they swipe: the
// order is signed against a bound derived at intent time and posted a second or two later, and that
// gap is closed by REAL_SLIPPAGE_BP below, not by polling.
export const QUOTES_MAX_IDS = 4; // per request — the visible card plus headroom, not a bulk feed
export const QUOTES_RATE_PER_MIN = 150; // 1s polling = 60/min; the rest is headroom for other surfaces

// Real-money balance refresh. The HUD states this number on every screen, so it has to become
// true without a reload — a deposit that only appears after F5 reads as a deposit that never
// arrived. One RPC read per interval per VISIBLE tab and none at all for a hidden one; a bridged
// deposit lands in a minute or two, so anything tighter would just re-read the same number.
export const REAL_BALANCE_POLL_MS = 15_000;
