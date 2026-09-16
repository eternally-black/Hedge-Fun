// F4 settlement poller. Standalone daemon (later a VPS cron). Run: npm run poll
//   - finds markets with PENDING bets
//   - fetches real Polymarket resolution
//   - settles in an idempotent transaction (P&L + shard on win)
//   - sweeps streak burns each tick
// Rule: thrown error = transient -> backoff/retry; a returned decision = commit it.
import { PrismaClient } from "@prisma/client";
import { writeFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { fetchResolution } from "../src/lib/polymarket";
import { withDeadline } from "../src/lib/deadline";
import { conditionResolution, type ChainOutcome } from "../src/lib/polygon";
import { DECK_FETCH_HORIZON_HOURS } from "../src/lib/deck-mix";
import { DECK_MIN_SERVABLE, STOCK_SPONSOR_MIN_LAMPORTS, STOCK_SPONSOR_LOW_ALERT_EVERY_MS } from "../src/lib/config";
import { captureToGlitchTip, sendOpsTelegram } from "../src/lib/glitchtip";
import { settleMarket, type Resolution } from "./settle";
import { watchFunding, rpcChain } from "../src/lib/funding";
import { watchStuckAttempts } from "../src/lib/attempts-watch";
import { settleResolvedRealPositions, expireStaleIntents } from "../src/lib/real-settle";
import { evaluateStreak } from "../src/lib/streak";
import { refreshDeck } from "./refresh-deck";
import { pruneMarkets } from "./prune-markets";
import { refreshHedgeIndex } from "./refresh-hedge-index";
import { refreshStockCatalog, refreshStockPrices } from "./refresh-stocks";
import { fillMissingBlurbs } from "../src/lib/stock-blurbs";
import { sweepAttempts } from "../src/lib/stocks-real";
import { evalStockAlerts } from "../src/lib/stock-alerts";
import { sponsorConfigured, sponsorAddress } from "../src/lib/sponsor";
import { getBalanceLamports } from "../src/lib/helius";
import { livePnlCents } from "../src/lib/stocks";
import { pruneReferralClicks } from "../src/lib/refclick";
import { acquirePollerLease, releasePollerLease } from "../src/lib/poller-lease";

const prisma = new PrismaClient();

const POLL_INTERVAL_MS = 60_000;
const CONCURRENCY = 4;

// Chain-probe budget per tick. Each probe is one eth_call round (3 calls) against a public RPC;
// a backlog of undecided markets must not hammer it. The oldest markets (by resolutionDeadline)
// get the budget first; the rest wait for the next tick.
const CHAIN_PROBES_PER_TICK = 25;
// Sports grace after the resolution deadline (kick-off): a match lasts a few hours and cannot have
// resolved during it, so probing the chain for its whole duration is wasted RPC. Three hours past
// kick-off is when a real resolution could first appear.
const SPORT_CHAIN_GRACE_MS = 3 * 3_600_000;
let chainProbesLeft = 0;

// The hedge market index (crypto S1 + sports/esports S2) rides the SAME poller as the deck (spec §2:
// "same poller cadence") but on a SLOWER sibling cadence — it's a heavier Gamma pull (majors tags +
// sports) than the deck refresh and hedge markets are longer-horizon, so per-minute freshness buys
// nothing. Every 5th tick ≈ every 5 minutes: fresh enough that a market resolving early on Polymarket
// (the F1 stale-cache snipe) is re-priced/closed within one window, cheap enough not to hammer Gamma.
// The accept-time price-band gate (src/lib/hedge/accept.ts) closes the intra-window remainder.
const HEDGE_INDEX_EVERY_N_TICKS = 5;
// Wall-clock budgets for a subsystem's upstream reads (withDeadline, src/lib/deadline.ts — honoured by
// the Gamma, CLOB and Polygon RPC readers). Measured 2026-09-02: a deck refresh takes 1–10 s, a warm
// hedge-index run 15–35 s, a cold-start one (empty caches, ~3100 sports rows) 63 s. During that day's
// Gamma outage (15:12–15:30Z, slow 500s) the run took 209–323 s: the heartbeat crossed its 180 s
// staleness bound mid-tick and the watchdog restarted the poller three times into the same outage.
// The RPC consumers are bounded the same way — N pending markets × a Gamma retry ladder plus up to 25
// chain probes × 3 calls × 10 s in the settle sweep, and a sequential balance read per open real
// position after it — because under an RPC outage those are unbounded by count too.
// The container only turns unhealthy after three 30 s checks in a row see the file older than 180 s,
// so a restart needs 240 s without a beat. Beats land after the lease, after each successful upstream
// subsystem, before the settle sweep and at the end of a clean tick, so the longest no-beat spans are
// deck 45 + index 120 = 165 s (plus the index's DB upserts, which a budget cannot cut) and settle 60 +
// funding 30 + real-settle 45 + the 20 s reconcile call = 155 s (plus DB). The stocks pass adds at most
// 10 s per tick (30 s on its catalog minute, which never coincides with the index; plus the 5 s
// sponsor-balance read, which rides that same minute). A request under a
// budget is clamped to what is left of it, so an in-flight request never extends the span. A budget hit is an
// ordinary subsystem failure — the previous deck / index rows stay, nothing partial is written,
// unsettled markets and unread balances wait a tick.
const DECK_GAMMA_BUDGET_MS = 45_000;
const HEDGE_INDEX_GAMMA_BUDGET_MS = 120_000;
const SETTLE_BUDGET_MS = 60_000;
const FUNDING_BUDGET_MS = 30_000;
const REAL_SETTLE_BUDGET_MS = 45_000;
// Market cache GC cadence. Every 5th tick ≈ every 5 minutes: fast enough to drain a large backlog
// in a few hours (PRUNE_MAX_ROWS per run), slow enough that the anti-join scan is not a per-minute
// cost in the steady state, where it finds nothing. Deliberately OFFSET from the hedge index above
// (see the tick body) so the two heavy passes don't land on the same tick.
const PRUNE_EVERY_N_TICKS = 5;
// Tokenized stocks (Stocklana). Prices for the SERVED subset every tick (≤ 3 Jupiter requests); the
// full xStocks catalog + all ~800 prices every 5th tick on phase 1 — deliberately not the hedge
// index's minute (phase 0) or the prune's (phase 2), so the heavy passes never stack on one tick.
const STOCK_PRICES_BUDGET_MS = 10_000;
const STOCK_CATALOG_BUDGET_MS = 30_000;
const STOCK_CATALOG_EVERY_N_TICKS = 5;
const STOCK_BLURB_BUDGET_MS = 20_000; // card copy: at most two LLM calls, on the catalog tick only
const STOCK_SWEEP_BUDGET_MS = 15_000; // pending real-buy attempts: a few Helius reads, or nothing at all
const STOCK_SPONSOR_BUDGET_MS = 5_000; // fee-payer balance: one getBalance call, on the catalog tick only
// Order reconciliation ping. The poller is deliberately SDK-free, so it cannot reconcile orders
// itself — it pings the route that can. Offset to tick phase 4 so it never lands on the same
// minute as the hedge index (phase 0) or the prune (phase 2).
const RECONCILE_EVERY_N_TICKS = 5;
let tickCount = 0;

// Silent-failure watch: subsystem errors are swallowed by design (a failed deck refresh
// must not kill settlement), so count consecutive failures and alert at 3. Reset on the
// first success; a recovery after an alert sends one OK message.
const FAIL_ALERT_AT = 3;
const failStreaks: Record<string, number> = {};
function subsystemFailed(name: string, e: unknown): void {
  failStreaks[name] = (failStreaks[name] ?? 0) + 1;
  // Capture and page at the SAME threshold, once per streak. Capturing every blip looked free
  // until GlitchTip's own alert webhook started forwarding each event to Telegram: a chronic
  // upstream hiccup (Gamma 500s on deep pages, once per few hours) becomes a cry-wolf feed that
  // buries the one alert that matters. A single transient failure lives in the container logs
  // (every catch above already console.warns it); a STREAK is a problem and pages exactly once,
  // with the recovery message below closing the loop.
  if (failStreaks[name] === FAIL_ALERT_AT) {
    void captureToGlitchTip(e, { subsystem: name, consecutive: String(FAIL_ALERT_AT) });
    void sendOpsTelegram(`🚨 poller: ${name} failed ${FAIL_ALERT_AT} consecutive times: ${(e as Error).message ?? String(e)}`);
  }
}
function subsystemOk(name: string): void {
  if ((failStreaks[name] ?? 0) >= FAIL_ALERT_AT) {
    void sendOpsTelegram(`✅ poller: ${name} recovered`);
  }
  failStreaks[name] = 0;
}
// Settlement-backlog alert throttle: one Telegram send per hour max while overdue persists.
let backlogLastAlertAt = 0;
// Sponsor-wallet alert throttle, same shape: one page per STOCK_SPONSOR_LOW_ALERT_EVERY_MS while the
// fee-payer stays below the floor, one "refilled" when it comes back.
let lastSponsorAlertAt = 0;

// Liveness signal: touched as a tick makes progress — after the lease is written, after each
// upstream-bound subsystem SUCCEEDS (deck, hedge index), before the settle sweep and at the end of
// every clean tick. The compose healthcheck fails the container when this file is stale
// (mtime older than ~3x the interval) so a wedged-but-not-exited loop gets restarted instead of
// sitting "up" with settlement dead. The mid-tick touches exist because a tick that is merely slow
// on upstream retries is not wedged: on 2026-09-02 a Gamma outage stretched the hedge-index run to
// 209–323 s, the file went stale mid-tick and the watchdog restarted a healthy poller three times.
// ponytail: a file beats a DB heartbeat row here — the healthcheck is just a stat() with no
// DB creds. Default lives under the OS temp dir so the same path resolves in the container.
const HEARTBEAT_FILE = process.env.POLLER_HEARTBEAT_FILE ?? join(tmpdir(), "poller-heartbeat");

function beat(): void {
  try {
    writeFileSync(HEARTBEAT_FILE, new Date().toISOString());
  } catch (e) {
    console.warn("[poll] heartbeat write failed:", (e as Error).message);
  }
}

// Per-subsystem timings for the tick's log line. The 2026-09-02 diagnosis had to reconstruct how
// long the hedge index ran from neighbouring log lines; now every tick says so itself. Lease, prune,
// reconcile and the backlog check are unmarked — they are the remainder of the total.
let tickMarks: string[] = [];
function mark(label: string, since: number): void {
  tickMarks.push(`${label} ${((Date.now() - since) / 1000).toFixed(1)}s`);
}

let running = true;
// One identity per process: the lease is acquired under it every tick and released under it on
// shutdown. A recreated container has a new pid, so without the release the successor idles until
// the TTL runs out — measured at two skipped ticks on the 2026-09-02 deploy.
const POLLER_HOLDER = `${hostname()}:${process.pid}`;

export function toResolution(m: Awaited<ReturnType<typeof fetchResolution>>): Resolution {
  if (!m) return { kind: "open" };
  if (m.status === "RESOLVED" && m.resolvedOutcome === "YES") return { kind: "resolved", resolvedYes: true };
  if (m.status === "RESOLVED" && m.resolvedOutcome === "NO") return { kind: "resolved", resolvedYes: false };
  // Polymarket has no explicit "void" in the fields we read; CANCELED would come from
  // an invalid resolution. For now anything not cleanly resolved -> still open.
  return { kind: "open" };
}

// The chain's verdict in the settler's own vocabulary. Index 0 is the YES outcome, index 1 the NO
// one, and a payout to both is the invalid/split resolution — this repo's "void".
export function chainToResolution(outcome: ChainOutcome | null): Resolution {
  if (outcome === "YES") return { kind: "resolved", resolvedYes: true };
  if (outcome === "NO") return { kind: "resolved", resolvedYes: false };
  if (outcome === "INVALID") return { kind: "void" };
  return { kind: "open" };
}

async function settleOne(market: { id: string; polymarketId: string; source: string; resolutionDeadline: Date; startsAt: Date | null }) {
  let resolution: Resolution = toResolution(await fetchResolution(market.polymarketId)); // may throw -> transient
  // Gamma is not the authority on resolution — the Conditional Tokens contract is, and it is
  // measurably AHEAD. Measured on our own positions 2026-08-19: markets flipped 5, 6, 7 and 16
  // minutes after their deadline, every one of them waiting on `umaResolutionStatus` while the
  // collateral had ALREADY been auto-redeemed into the wallet. For those minutes the app said
  // "awaiting result" about money the user had been paid, and offered to sell a position that no
  // longer existed. So once the deadline has passed and Gamma still says open, ask the contract
  // that pays the money. POLYMARKET only: a synthetic id (TXODDS) is not a conditionId.
  // Sports get a grace period past kick-off (their deadline) — a match cannot resolve during play.
  if (
    resolution.kind === "open" &&
    market.source === "POLYMARKET" &&
    Date.now() >= market.resolutionDeadline.getTime() + (market.startsAt ? SPORT_CHAIN_GRACE_MS : 0)
  ) {
    // Budgeted: the oldest markets (sorted by resolutionDeadline before mapLimit) get the
    // CHAIN_PROBES_PER_TICK probes first; the rest stay open for the next tick. A public RPC
    // must not see one round per stuck market per tick, unbounded by count.
    if (chainProbesLeft > 0) {
      chainProbesLeft--;
      resolution = chainToResolution(await conditionResolution(market.polymarketId)); // may throw -> transient
      if (resolution.kind !== "open") {
        console.log(`[settle] ${market.polymarketId.slice(0, 16)}… resolved from CHAIN (Gamma still open)`);
      }
    }
  }
  if (resolution.kind === "open") return;
  const r = await settleMarket(prisma, market.id, resolution);
  await prisma.market.update({ where: { id: market.id }, data: { lastPolledAt: new Date() } });
  if (r.settled + r.voided > 0) {
    console.log(
      `[settle] ${market.source} ${market.polymarketId.slice(0, 16)}… settled=${r.settled} void=${r.voided} shards=${r.shardsAwarded}`,
    );
  }
}

// Process an array with a bounded concurrency, isolating per-item errors.
// Exported so scripts/test-poller-maplimit.ts can unit-test the error-isolation + bounded
// concurrency in isolation (importing this module does NOT start loop() — see runAsDaemon guard).
export async function mapLimit<T>(items: T[], limit: number, fn: (t: T) => Promise<void>, onError?: (e: unknown) => void) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift()!;
      try {
        await fn(item);
      } catch (e) {
        console.warn("[poll] item error (will retry next tick):", (e as Error).message);
        onError?.(e);
      }
    }
  });
  await Promise.all(workers);
}

async function tick() {
  tickCount++;
  tickMarks = [];
  // Single-runner lease: funding watch, prune and the S2 clear-pass must not double-run when two
  // poller processes are up (a deploy overlap, say). The lease outlives a tick by one interval so
  // a crashed holder frees it by itself.
  if (!(await acquirePollerLease(prisma, POLLER_HOLDER, 2 * POLL_INTERVAL_MS))) {
    console.warn("[poller] another runner holds the lease — skipping tick");
    return;
  }
  // A lease row just got written: the DB is up and the loop is moving, so the heartbeat span starts
  // here rather than at the previous tick's end — that gap would include the inter-tick sleep.
  beat();
  let t = Date.now();
  // Keep the deck cache warm so swipes lock fresh prices and expired markets drop (M4).
  // Pull the OUTER window (max per-category horizon) to match the deck route — otherwise the
  // longer-horizon sports/esports half never gets price refreshes and shows stale (often 50/50)
  // odds. fetchBlitzDeck still drops each market past its own category horizon.
  try {
    const r = await withDeadline(DECK_GAMMA_BUDGET_MS, () => refreshDeck(DECK_FETCH_HORIZON_HOURS, 100));
    // Log the SERVABLE count next to the upserted one. Reporting only "refreshed N" is what hid a
    // multi-week outage: N stayed at 100 the whole time the deck was empty, because every one of
    // those 100 expired within minutes. The alarm below is deliberately loud and greppable —
    // starving inventory is an upstream/product condition, not a crash, so nothing else surfaces it.
    if (r.servable < DECK_MIN_SERVABLE) {
      console.error(
        `[deck] ALARM: only ${r.servable} servable markets (floor ${DECK_MIN_SERVABLE}) of ${r.upserted} refreshed — the deck is starving`,
      );
    } else {
      console.log(`[deck] refreshed ${r.upserted} markets (${r.servable} servable)`);
    }
    subsystemOk("deck");
    beat();
  } catch (e) {
    console.warn("[deck] refresh error:", (e as Error).message);
    subsystemFailed("deck", e);
  }
  mark("deck", t);

  // Hedge market index (S1 crypto majors + S2 sports/esports) — SLOWER sibling cadence (every Nth
  // tick). Runs on the FIRST tick after boot then every HEDGE_INDEX_EVERY_N_TICKS ticks, so a fresh
  // poller populates it promptly and it stays warm thereafter. Freshness kills the F1 snipe window
  // (a market resolved-early on Polymarket gets re-priced/closed here); F2's clear-pass drops rows
  // that fell out of the fetch/band. A refresh failure is transient — log and keep the tick alive.
  if ((tickCount - 1) % HEDGE_INDEX_EVERY_N_TICKS === 0) {
    t = Date.now();
    try {
      const hs = await withDeadline(HEDGE_INDEX_GAMMA_BUDGET_MS, () => refreshHedgeIndex());
      console.log(
        `[hedge-index] S1 parsed=${hs.parsed}/${hs.discovered} | S2 eligible=${hs.sports.eligible}/${hs.sports.discovered} cleared=${hs.sports.clearedStale}`,
      );
      subsystemOk("hedge-index");
      beat();
    } catch (e) {
      console.warn("[hedge-index] refresh error:", (e as Error).message);
      subsystemFailed("hedge-index", e);
    }
    mark("index", t);
  }

  // Stock prices/catalog. Same shape as the deck refresh: budgeted upstream reads, one summary line,
  // a beat on success. The catalog tick (phase 1) also re-ranks deck eligibility; the price tick keeps
  // the served subset, open positions and the hedge tickers fresh (STOCK_PRICE_MAX_STALE_MS gates).
  t = Date.now();
  try {
    if ((tickCount - 1) % STOCK_CATALOG_EVERY_N_TICKS === 1) {
      const c = await withDeadline(STOCK_CATALOG_BUDGET_MS, () => refreshStockCatalog());
      console.log(`[stocks] catalog ${c.assets} assets, ${c.priced} priced, ${c.eligible} deck-eligible`);
      // Zero priced with a non-empty catalog = Jupiter served nothing. Not thrown upstream (a
      // partial read is a success by design), but three ticks of it empties the deck silently.
      if (c.assets > 0 && c.priced === 0) throw new Error(`0 of ${c.assets} assets priced`);
      // Card copy for the newly catalogued assets. Its own try/catch and its own budget: a blurb is
      // decoration, and an LLM outage must never mark the stocks subsystem failed (no key = a no-op).
      try {
        const b = await withDeadline(STOCK_BLURB_BUDGET_MS, () => fillMissingBlurbs(prisma, { max: 40 }));
        if (b.written > 0) console.log(`[stocks] blurbs +${b.written}`);
      } catch (e) {
        console.warn("[stocks] blurb fill error:", (e as Error).message);
      }
    } else {
      const p = await withDeadline(STOCK_PRICES_BUDGET_MS, () => refreshStockPrices());
      console.log(`[stocks] repriced ${p.priced}/${p.requested}`);
      if (p.requested > 0 && p.priced === 0) throw new Error(`0 of ${p.requested} mints repriced`);
    }
    subsystemOk("stocks");
    beat();
  } catch (e) {
    console.warn("[stocks] refresh error:", (e as Error).message);
    subsystemFailed("stocks", e);
  }
  mark("stocks", t);

  // Real stock buys whose tab died between "sent" and "confirm": re-confirm the ones that carry a
  // signature, adopt the ones we can find on chain, expire the rest once their blockhash is gone.
  // Returns immediately (no RPC) when nothing is pending, which is the steady state.
  t = Date.now();
  try {
    const sw = await withDeadline(STOCK_SWEEP_BUDGET_MS, () => sweepAttempts());
    if (sw.scanned > 0) {
      console.log(`[stock-attempts] scanned ${sw.scanned}: confirmed ${sw.confirmed}, expired ${sw.expired}, failed ${sw.failed}`);
    }
    // A FAILED attempt is a signed on-chain tx that landed with an error: a user's real USDC path.
    // Page immediately (not on a streak) — one line per tick that saw one, which is rare.
    if (sw.failed > 0) void sendOpsTelegram(`⚠️ stocks: ${sw.failed} on-chain buy attempt(s) FAILED this tick — see GlitchTip (attempt ids)`);
    subsystemOk("stock-attempts");
  } catch (e) {
    console.warn("[stock-attempts] sweep error:", (e as Error).message);
    subsystemFailed("stock-attempts", e);
  }
  mark("stock-attempts", t);

  // Stock profit alerts: DB-only, reads the prices the stocks block just wrote. No withDeadline —
  // nothing upstream is read; the pass is bounded by STOCK_ALERT_SCAN_MAX / FIRE_MAX. A tier fires
  // once per lot (conditional update), so a restart never re-fires.
  t = Date.now();
  try {
    const sa = await evalStockAlerts(prisma, livePnlCents);
    if (sa.fired + sa.errors > 0) console.log(`[stock-alerts] scanned ${sa.scanned}, fired ${sa.fired}, skipped ${sa.skipped}, errors ${sa.errors}`);
    if (sa.errors > 0) subsystemFailed("stock-alerts", new Error(`${sa.errors} lot(s) failed`));
    else subsystemOk("stock-alerts");
  } catch (e) {
    console.warn("[stock-alerts] error:", (e as Error).message);
    subsystemFailed("stock-alerts", e);
  }
  mark("stock-alerts", t);

  // Fee-payer wallet. Every sponsored buy/sell is signed and paid by it, so an empty sponsor breaks
  // the whole real path with no other symptom a probe outside can name — the swap simply never gets
  // sent. One getBalance call on the catalog's minute: a wallet that drains inside five minutes is
  // not a case a poller can save, and the health probe reads the same balance per request anyway.
  if (sponsorConfigured() && (tickCount - 1) % STOCK_CATALOG_EVERY_N_TICKS === 1) {
    t = Date.now();
    try {
      const addr = sponsorAddress();
      if (!addr) throw new Error("sponsor configured but its address could not be derived");
      const lamports = await withDeadline(STOCK_SPONSOR_BUDGET_MS, () => getBalanceLamports(addr));
      const sol = Number(lamports) / 1e9;
      console.log(`[stock-sponsor] balance ${sol.toFixed(4)} SOL`);
      if (lamports < BigInt(STOCK_SPONSOR_MIN_LAMPORTS)) {
        // Throttled, not per-tick: a low balance persists for as long as nobody funds it, and the
        // fix (send SOL) is not faster for being asked twelve times an hour.
        if (Date.now() - lastSponsorAlertAt > STOCK_SPONSOR_LOW_ALERT_EVERY_MS) {
          lastSponsorAlertAt = Date.now();
          void sendOpsTelegram(
            `⚠️ stocks: sponsor wallet low — ${sol.toFixed(4)} SOL (min ${(STOCK_SPONSOR_MIN_LAMPORTS / 1e9).toFixed(2)}). Real buys/sells will start failing.`,
          );
        }
      } else if (lastSponsorAlertAt !== 0) {
        lastSponsorAlertAt = 0;
        void sendOpsTelegram("✅ stocks: sponsor wallet refilled");
      }
      subsystemOk("stock-sponsor");
    } catch (e) {
      console.warn("[stock-sponsor] balance read error:", (e as Error).message);
      subsystemFailed("stock-sponsor", e);
    }
    mark("stock-sponsor", t);
  }

  // Market cache GC. The cache is append-only otherwise: settlement only touches markets that have
  // bets, so everything nobody bet on accumulates forever. Bounded per run, so a backlog drains over
  // a few hours instead of one long table lock. OFFSET by 2 ticks from the hedge index above so the
  // two heavy passes never land on the same minute as each other (or on the boot tick).
  if ((tickCount - 1) % PRUNE_EVERY_N_TICKS === 2) {
    try {
      const p = await pruneMarkets();
      if (p.deleted > 0) console.log(`[prune] deleted ${p.deleted} dead markets${p.more ? " (more queued)" : ""}`);
      subsystemOk("prune");
    } catch (e) {
      console.warn("[prune] error:", (e as Error).message);
      subsystemFailed("prune", e);
    }
    try {
      const n = await pruneReferralClicks();
      if (n > 0) console.log(`[prune] ${n} referral click(s) older than 24h`);
      subsystemOk("prune-clicks");
    } catch (e) {
      console.warn("[prune] referral-click error:", (e as Error).message);
      subsystemFailed("prune-clicks", e);
    }
  }

  // Markets that still have unsettled bets of EITHER mode and are not yet terminal. Real bets
  // never paper-settle (settleMarket filters mode internally) but their markets MUST get the
  // status flip or REDEEM can never bind (K3 S6/S7 HIGH-1); the market-status predicate bounds
  // the scan — once terminal, the market drops out even while real bets stay PENDING.
  // groupBy runs server-side; the old findMany+distinct materialised every pending bet in the
  // client to derive a market list.
  const pendingGroups = await prisma.bet.groupBy({
    by: ["marketId"],
    where: { settlementStatus: "PENDING", market: { status: "OPEN" } },
  });
  const ids = pendingGroups.map((g) => g.marketId);
  const markets = await prisma.market.findMany({
    where: { id: { in: ids }, status: "OPEN" },
    select: { id: true, polymarketId: true, source: true, resolutionDeadline: true, startsAt: true },
    orderBy: { resolutionDeadline: "asc" }, // oldest first — they get the chain-probe budget
  });
  // The DB just answered twice and the loop reached the sweep: that is progress, so the heartbeat
  // span restarts here — the deck and index budgets on one side of it, the sweep's on the other.
  beat();
  t = Date.now();
  if (markets.length) {
    console.log(`[poll] ${markets.length} market(s) with pending bets`);
    // Oldest deadlines first, so a budget hit leaves the NEWEST markets for the next tick. The head is
    // stable across ticks, so a market that can never resolve would starve the tail — that is the
    // backlog alarm's case below, not a reason to rotate the order.
    let settleErrors = 0;
    let refused = 0; // budget spent before the market was even read — not a failure of that market
    chainProbesLeft = CHAIN_PROBES_PER_TICK;
    await withDeadline(SETTLE_BUDGET_MS, () =>
      mapLimit(markets, CONCURRENCY, settleOne, (e) => {
        if (/time budget exhausted/.test((e as Error).message)) refused++;
        else settleErrors++;
      }),
    );
    if (refused > 0) console.warn(`[settle] budget hit — ${refused}/${markets.length} market(s) not reached this tick`);
    if (settleErrors + refused > 0) {
      subsystemFailed("settle", new Error(`${settleErrors} settle item error(s), ${refused} not reached this tick`));
    } else subsystemOk("settle");
  }
  mark("settle", t);

  // Deposit watcher (plan §2.5): delta-based funding detection every tick; the lib applies the
  // tiered per-attempt cadence itself, so calling it each tick is cheap. RPC errors surface as a
  // subsystem failure only when NOTHING could be checked — per-attempt errors are counted inside.
  t = Date.now();
  try {
    const f = await withDeadline(FUNDING_BUDGET_MS, () => watchFunding(prisma, undefined, new Date(), rpcChain));
    if (f.checked + f.errors > 0) {
      console.log(`[funding] checked ${f.checked}, detected ${f.detected}, funded ${f.funded}, errors ${f.errors}`);
    }
    if (f.errors > 0 && f.checked === 0) subsystemFailed("funding", new Error(`${f.errors} watcher error(s), 0 checked`));
    else subsystemOk("funding");
  } catch (e) {
    console.warn("[funding] watcher error:", (e as Error).message);
    subsystemFailed("funding", e);
  }
  mark("funding", t);

  // REAL positions on markets that have already resolved. A LOST one redeems to zero, so it needs
  // no signature and no relayer — waiting for the user to open a developer console and press REDEEM
  // is not settlement, it is a position sitting "open" for hours after the match ended. Winners are
  // booked only once the collateral has demonstrably moved — the outcome token has left the wallet,
  // which is what Polymarket's auto-redeemer does with the operator right granted at activation.
  // Resolution alone is not proof, so the token balance is what the pass reads.
  // The same pass clears intents nobody signed — one such row holds the market's in-flight slot and
  // the intent route only expires it when a NEW intent arrives for that same market, which never
  // comes if the reason nobody retried is that the button correctly disappeared.
  t = Date.now();
  try {
    const rs = await withDeadline(REAL_SETTLE_BUDGET_MS, () => settleResolvedRealPositions(prisma));
    if (rs.lost + rs.won + rs.dust > 0)
      console.log(`[real-settle] booked ${rs.won} won, ${rs.lost} lost, ${rs.dust} sub-tick remnant(s)`);
    if (rs.winnersPending > 0) console.warn(`[real-settle] ${rs.winnersPending} won position(s) not yet redeemed on chain`);
    if (rs.inFlight > 0) console.log(`[real-settle] ${rs.inFlight} resolved position(s) waiting on an in-flight order`);
    const expired = await expireStaleIntents(prisma);
    if (expired > 0) console.log(`[real-settle] expired ${expired} unsigned intent(s)`);
    // Per-row failures no longer unwind the pass, so they no longer reach the catch below — report
    // them here or a deterministic bad row degrades into a silent counter forever.
    if (rs.errors > 0) subsystemFailed("real-settle", new Error(`${rs.errors} position(s) failed to settle`));
    else subsystemOk("real-settle");
  } catch (e) {
    console.warn("[real-settle] error:", (e as Error).message);
    subsystemFailed("real-settle", e);
  }
  mark("real-settle", t);

  // Stuck real-order attempts (S8): ambiguous submissions must reach ops, never silently rot.
  try {
    const sa = await watchStuckAttempts(prisma);
    if (sa.stuck > 0) console.warn(`[real] ${sa.stuck} stuck order attempt(s) awaiting reconciliation`);
    subsystemOk("real-attempts");
  } catch (e) {
    console.warn("[real] stuck-attempt watcher error:", (e as Error).message);
    subsystemFailed("real-attempts", e);
  }

  // Order reconciliation (plan §2.1 step 6): POSTED attempts are resolved against the exchange's
  // own records by /api/real/reconcile — the SDK lives there, not here. Feature-gated by env
  // (unset = off, alpha default). A non-ok response is a subsystem FAILURE on purpose: a 401 or
  // 503 means reconciliation is silently NOT happening, which is exactly what ops must hear.
  const reconcileUrl = process.env.REAL_RECONCILE_URL;
  const reconcileSecret = process.env.REAL_RECONCILE_SECRET;
  if (reconcileUrl && reconcileSecret && (tickCount - 1) % RECONCILE_EVERY_N_TICKS === 4) {
    try {
      const resp = await fetch(reconcileUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-reconcile-secret": reconcileSecret },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(20_000),
      });
      if (!resp.ok) throw new Error(`reconcile HTTP ${resp.status}`);
      const c = (await resp.json()) as Partial<Record<"booked" | "killed" | "pending" | "unknown" | "scanned", number>> & {
        orphans?: Partial<Record<"adopted" | "killed" | "unknown" | "scanned", number>>;
      };
      if ((c.scanned ?? 0) > 0) {
        console.log(
          `[real-reconcile] scanned ${c.scanned}: booked ${c.booked ?? 0}, killed ${c.killed ?? 0}, pending ${c.pending ?? 0}, unknown ${c.unknown ?? 0}`,
        );
      }
      // The orphan sweep resolves attempts the browser posted but never reported (no
      // externalOrderId). It is the only thing that unwedges those market slots, so its numbers are
      // logged separately rather than folded into the counts above.
      const o = c.orphans;
      if ((o?.scanned ?? 0) > 0) {
        console.log(
          `[real-orphans] scanned ${o?.scanned}: adopted ${o?.adopted ?? 0}, killed ${o?.killed ?? 0}, unknown ${o?.unknown ?? 0}`,
        );
      }
      subsystemOk("real-reconcile");
    } catch (e) {
      console.warn("[real-reconcile] error:", (e as Error).message);
      subsystemFailed("real-reconcile", e);
    }
  }

  // Streak sweep — only streaks that can actually transition (M1): ACTIVE that missed a
  // day, or BURNED_RECOVERABLE whose window has expired. Everything else is a no-op the
  // read-path handles. Avoids one transaction per user per tick.
  t = Date.now();
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
  const due = await prisma.streak.findMany({
    where: {
      OR: [
        { state: "ACTIVE", lastQualifiedDay: { lte: twoDaysAgo } },
        { state: "BURNED_RECOVERABLE", recoverableUntil: { lt: new Date() } },
      ],
    },
    select: { userId: true },
  });
  let streakErrors = 0;
  for (const s of due) {
    try {
      await evaluateStreak(s.userId);
    } catch (e) {
      console.warn("[streak] sweep error:", (e as Error).message);
      streakErrors++;
    }
  }
  if (streakErrors > 0) subsystemFailed("streak", new Error(`${streakErrors} streak sweep error(s)`));
  else subsystemOk("streak");
  mark("streak", t);

  // Backlog: a PENDING bet >6h past its market's resolutionDeadline means settlement is
  // not keeping up (or resolution fetch is broken) — the heartbeat alone would stay green.
  const overdue = await prisma.bet.findFirst({
    where: {
      settlementStatus: "PENDING",
      // PAPER: settlement is simply late. REAL is a different failure and used to be excluded
      // outright, which made it silent: a market that resolves WITHOUT a clean 1/0 price print
      // (a UMA invalid, say) never leaves OPEN here — mapMarket refuses to call it terminal and
      // toResolution keeps returning "open" — so REDEEM can never bind it (redeem.ts requires a
      // terminal market) and the position is stranded in-app while still redeemable on chain.
      // The qualifier is what keeps this honest: a PENDING real bet on an already-terminal market
      // is the ordinary "waiting for the user to press redeem" state and must NOT page anyone.
      OR: [
        { mode: "PAPER" },
        // Non-terminal covers TWO shapes, not one. A market can sit in OPEN forever (mapMarket
        // refuses to call a non-clean price print terminal), and it can sit in RESOLVED with a NULL
        // outcome — which redeem.ts treats as undecided for exactly the same reason, and which is
        // just as unredeemable. Matching only OPEN left the second one as silent as before.
        { mode: "REAL", market: { status: "OPEN" } },
        { mode: "REAL", market: { status: "RESOLVED", resolvedOutcome: null } },
      ],
      // A sports deadline is kick-off, so a match that takes longer than the game itself to settle
      // is not a backlog — twelve hours covers the match plus the resolver's lag.
      market: {
        OR: [
          { startsAt: null, resolutionDeadline: { lt: new Date(Date.now() - 6 * 3_600_000) } },
          { startsAt: { not: null }, resolutionDeadline: { lt: new Date(Date.now() - 12 * 3_600_000) } },
        ],
      },
    },
    orderBy: { market: { resolutionDeadline: "asc" } },
    select: { market: { select: { resolutionDeadline: true, polymarketId: true } } },
  });
  if (overdue && Date.now() - backlogLastAlertAt > 3_600_000) {
    backlogLastAlertAt = Date.now();
    void sendOpsTelegram(
      `🚨 poller: settlement backlog — oldest pending bet past deadline ${overdue.market.resolutionDeadline.toISOString()} (market ${overdue.market.polymarketId.slice(0, 16)})`,
    );
  } else if (!overdue && backlogLastAlertAt !== 0) {
    backlogLastAlertAt = 0;
    void sendOpsTelegram("✅ poller: settlement backlog cleared");
  }
}

async function loop() {
  console.log("poller started. interval", POLL_INTERVAL_MS, "ms");
  // Heartbeat before the first tick: the file means "alive and making progress", and before the
  // first tick completes the process is alive by definition. The cold-start tick (deck + the full
  // hedge index) outlasts the healthcheck's start_period, which failed `compose up --wait` on
  // 2026-09-02. A wedged first tick is still caught by the 180s staleness bound.
  beat();
  while (running) {
    const start = Date.now();
    try {
      await tick();
      // The end-of-tick beat lands only on a clean tick, and the mid-tick beats (see beat()) only on
      // progress — a lease written, a subsystem succeeded, the sweep reached — so a tick that fails
      // everywhere (a wedged DB pool, say) still lets the file go stale and the healthcheck restarts
      // us rather than masking a persistent failure.
      beat();
      // Dead-man ping for the external uptime check (Kuma push, 300 s window): deliberately NOT in
      // beat() — the file says "alive", this says "a tick completed end to end", and a crashloop or a
      // tick that throws every time past the mid-tick beats must still turn it red. With the budgets
      // above a healthy tick stays far under the window. No-op without POLLER_HC_URL.
      const hc = process.env.POLLER_HC_URL;
      if (hc) fetch(hc, { signal: AbortSignal.timeout(5000) }).catch(() => {});
    } catch (e) {
      console.error("[poll] tick failed:", (e as Error).message);
      void captureToGlitchTip(e, { subsystem: "tick" });
    }
    const elapsed = Date.now() - start;
    console.log(`[poll] tick #${tickCount} ${(elapsed / 1000).toFixed(1)}s${tickMarks.length ? ` — ${tickMarks.join(", ")}` : ""}`);
    await new Promise((r) => setTimeout(r, Math.max(0, POLL_INTERVAL_MS - elapsed)));
  }
}

// Only start the daemon when this file is the entry point — dev `tsx scripts/poller.ts` (poller.ts)
// AND prod `node dist/poller.cjs` (the esbuild bundle). Importing this module (e.g.
// scripts/test-poller-resolution.ts unit-testing toResolution) must NOT spin up the loop or install
// process-killing handlers — its entry is test-*.ts, which doesn't match. Matching ONLY "poller.ts"
// silently disabled the prod poller (entry is poller.cjs) — keep both extensions.
const runAsDaemon = /(?:^|[\\/])poller\.(?:ts|cjs)$/.test(process.argv[1] ?? "");
if (runAsDaemon) {
  // Crash on a fault instead of limping on: an unhandled rejection / uncaught exception can
  // leave the loop wedged while Docker still reports the container "up". Exit(1) so
  // `restart: unless-stopped` actually fires.
  process.on("unhandledRejection", (reason) => {
    console.error("[poll] unhandledRejection:", reason);
    // Capture the fault before exiting; the 3s timer is the ceiling, the capture's finally the floor.
    (setTimeout(() => process.exit(1), 3000) as unknown as { unref?: () => void }).unref?.(); // Node returns a Timeout; DOM typings say number
    void captureToGlitchTip(reason, { subsystem: "fatal" }).finally(() => process.exit(1));
  });
  process.on("uncaughtException", (err) => {
    console.error("[poll] uncaughtException:", err);
    (setTimeout(() => process.exit(1), 3000) as unknown as { unref?: () => void }).unref?.(); // Node returns a Timeout; DOM typings say number
    void captureToGlitchTip(err, { subsystem: "fatal" }).finally(() => process.exit(1));
  });

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.log(`\n${sig} -> stopping…`);
      running = false;
      // Hand the lease back before going, bounded so a slow DB cannot outlast the stop grace.
      void Promise.race([
        releasePollerLease(prisma, POLLER_HOLDER).catch(() => false),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]).then(() => prisma.$disconnect().then(() => process.exit(0)));
    });
  }

  loop();
}
