# Hedge Fun — Build-Now Plan (start without answers)

> Companion to `hedge-fun-july-mvp-spec.md`. This covers only what can be coded **right now**, while the open questions are still unanswered. Principle: build the entire locked skeleton; hide the three open rules (×2, login-bonus size, referral reward) behind a config / single function, so that tomorrow's answers become a change in one place, not a refactor.

---

## 1. Build in full (locked, zero dependency on answers)

- **F1. Auth & onboarding** — Privy (email / Twitter), provision an embedded wallet on signup, persist account/progress.
- **F2. Blitz deck** — Polymarket read-integration (Gamma / data API), filter to **≤24h until resolution**, card model (question, Y/N price, time-to-resolution), deck assembly and refresh.
- **F4. Resolution & settlement loop** — store a swipe as a bet with a locked price → poll real Polymarket resolution → settle virtual $ → award a shard on a win. *(The hardest and riskiest piece — start here first.)*
- **F3. Swipe → bet capture** — Y/N swipe, 10/day cap, reset at 00:00 UTC. *(Starting balance and stake size are your call — see §3.)*
- **F5 (core). Points ledger** — swipe points (1/swipe, max 10/day), per-day UTC counters, the ledger schema itself (so every point type writes into one place).
- **F6. Streak** — day = login + opening the deck; rolling window; burns on a miss; state machine `active / burned_recoverable / lost`.
- **F7. Shards / artifacts / recovery** — 1 win = 1 shard (max 10/day), 20 shards = 1 artifact, 3-day recovery window, resume at n+1, unlimited hoarding, persists.
- **The full data model (§7 of the spec)** — entity shapes don't depend on the answers (only values/rules do). Build the whole schema now, including fields for referrals and the leaderboard.

---

## 2. Build the mechanism, keep the rule swappable (seam)

Here you build **all the plumbing** and isolate the actual decision into a single point:

- **Login bonus** — accrual + the daily "GM" button UI. Amount = a config constant (temporary, e.g. `LOGIN_BONUS = 5`). When the number arrives tomorrow, change the constant.
- **×2 streak multiplier** — build the streak counter fully (F6 is locked anyway). Implement the multiplier as a **separate rule over swipe points, in one place** (function/config), not scattered across the code. Don't commit to either the trigger (7 days vs 70 points) or the cadence (one-time vs continuous): the ledger writes raw swipe points, and the multiplier is applied via a strategy we "turn on." When the answer comes, implement the chosen branch in a single point.
- **Referrals (capture)** — invite-link generation, inviter↔invitee relationship, a `qualified_at` field. **Log everything now.** Reward computation (20% ongoing/one-time, levels, anti-abuse) is a deferred rule computed from logged data. Critical: store enough events so the reward can be applied **retroactively** once the rules arrive — don't lose referral-relationship or event data.
- **Leaderboard (readiness)** — the points ledger must support ranking queries (by design it already does). Defer the UI/endpoint until "yes/no." No wasted work either way.

---

## 3. Decisions you make yourself now (don't wait — these are implementation-side)

To avoid blocking F3/F7, lock defaults now; tweak later if needed:

- **Starting virtual $ balance** — suggest a fixed value, e.g. `$1000` virtual.
- **Stake per swipe** — for the MVP, the simplest is a **fixed stake per swipe** (e.g. `$100` virtual). "Choose your stake" can come later; for speed, go fixed.
- **Over-cap swiping** — suggest **allow swiping past the cap but with no points** (less frustration) rather than blocking.
- **Multi-day gap / >1 artifact** — recovery fixes **one gap**, **one artifact per recovery**; multiple missed days are not recoverable.

*(These are defaults, not dogma — but they unblock coding today.)*

---

## 4. Don't touch right now

- Anything mainnet / real money / custody / builder codes — September.
- Point sink beyond streak recovery — open, likely not July.
- **Token/airdrop promises in copy** — still open; keep **neutral "collect points" copy** in the UI, no promises, to avoid creating obligations.
- Leaderboard UI — until the answer.
- iOS.

---

## 5. Critical path (order for ~7 days)

The risk sits in the Polymarket integration (F2 read + F4 resolution loop), not in the frontend/swipe. So front-load the risk:

1. **Day 1–2:** F1 (Privy auth + embedded wallet) + data-schema skeleton.
2. **Day 1–3 (parallel):** F2 (Polymarket read + ≤24h filter + deck). ← de-risk early: API limits, resolution data shape, depth of the ≤24h pool.
3. **Day 2–4:** F4 (resolution/settlement loop — the newest/riskiest block) + F3 (swipe → bet capture).
4. **Day 3–5:** F5 ledger + swipe points, F6 streak, F7 shards/artifacts/recovery.
5. **Day 4–6:** login bonus + ×2 seam + referral capture + ranking queries for the leaderboard.
6. **Day 6–7:** assemble the frontend, polish, end-to-end test the daily loop — UTC rollover, streak burn/recovery, settlement.

The point of the ordering: if Polymarket throws a surprise (rate limits, resolution format, too few ≤24h markets), you find out on day 2, not day 6.

---

## 6. Where tomorrow's answers land (so nothing gets rewritten)

| Answer on | Plugs into | Change size |
|---|---|---|
| ×2 trigger + cadence (Q1–2) | one rule-function over swipe points | implement the chosen branch in 1 place |
| Login-bonus size (Q3) | config constant | 1 line |
| Referral params (Q4–7) | deferred computation over logged referral events | implement the rule + (if needed) a retroactive pass |
| Sink / token / copy (Q8–10) | UI copy + future sink | copy now, mechanics later |
| Leaderboard yes/no (Q11) | endpoint + UI on top of ready queries | add the render, data already there |
