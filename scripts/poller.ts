// F4 settlement poller. Standalone daemon (later a VPS cron). Run: npm run poll
//   - finds markets with PENDING bets
//   - fetches real Polymarket resolution
//   - settles in an idempotent transaction (P&L + shard on win)
//   - sweeps streak burns each tick
// Rule: thrown error = transient -> backoff/retry; a returned decision = commit it.
import { PrismaClient } from "@prisma/client";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchResolution } from "../src/lib/polymarket";
import { conditionResolution, type ChainOutcome } from "../src/lib/polygon";
import { DECK_FETCH_HORIZON_HOURS } from "../src/lib/deck-mix";
import { DECK_MIN_SERVABLE } from "../src/lib/config";
import { captureToGlitchTip, sendOpsTelegram } from "../src/lib/glitchtip";
import { settleMarket, type Resolution } from "./settle";
import { watchFunding, rpcChain } from "../src/lib/funding";
import { watchStuckAttempts } from "../src/lib/attempts-watch";
import { settleResolvedRealPositions, expireStaleIntents } from "../src/lib/real-settle";
import { evaluateStreak } from "../src/lib/streak";
import { refreshDeck } from "./refresh-deck";
import { pruneMarkets } from "./prune-markets";
import { refreshHedgeIndex } from "./refresh-hedge-index";
import { pruneReferralClicks } from "../src/lib/refclick";

const prisma = new PrismaClient();

const POLL_INTERVAL_MS = 60_000;
const CONCURRENCY = 4;

// The hedge market index (crypto S1 + sports/esports S2) rides the SAME poller as the deck (spec §2:
// "same poller cadence") but on a SLOWER sibling cadence — it's a heavier Gamma pull (majors tags +
// sports) than the deck refresh and hedge markets are longer-horizon, so per-minute freshness buys
// nothing. Every 5th tick ≈ every 5 minutes: fresh enough that a market resolving early on Polymarket
// (the F1 stale-cache snipe) is re-priced/closed within one window, cheap enough not to hammer Gamma.
// The accept-time price-band gate (src/lib/hedge/accept.ts) closes the intra-window remainder.
const HEDGE_INDEX_EVERY_N_TICKS = 5;
// Market cache GC cadence. Every 5th tick ≈ every 5 minutes: fast enough to drain a large backlog
// in a few hours (PRUNE_MAX_ROWS per run), slow enough that the anti-join scan is not a per-minute
// cost in the steady state, where it finds nothing. Deliberately OFFSET from the hedge index above
// (see the tick body) so the two heavy passes don't land on the same tick.
const PRUNE_EVERY_N_TICKS = 5;
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

// Liveness signal: touched at the end of every successful tick. The compose healthcheck
// fails the container when this file is stale (mtime older than ~3x the interval) so a
// wedged-but-not-exited loop gets restarted instead of sitting "up" with settlement dead.
// ponytail: a file beats a DB heartbeat row here — the healthcheck is just a stat() with no
// DB creds. Default lives under the OS temp dir so the same path resolves in the container.
const HEARTBEAT_FILE = process.env.POLLER_HEARTBEAT_FILE ?? join(tmpdir(), "poller-heartbeat");

let running = true;

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

async function settleOne(market: { id: string; polymarketId: string; source: string; resolutionDeadline: Date }) {
  let resolution: Resolution = toResolution(await fetchResolution(market.polymarketId)); // may throw -> transient
  // Gamma is not the authority on resolution — the Conditional Tokens contract is, and it is
  // measurably AHEAD. Measured on our own positions 2026-08-19: markets flipped 5, 6, 7 and 16
  // minutes after their deadline, every one of them waiting on `umaResolutionStatus` while the
  // collateral had ALREADY been auto-redeemed into the wallet. For those minutes the app said
  // "awaiting result" about money the user had been paid, and offered to sell a position that no
  // longer existed. So once the deadline has passed and Gamma still says open, ask the contract
  // that pays the money. POLYMARKET only: a synthetic id (TXODDS) is not a conditionId.
  if (
    resolution.kind === "open" &&
    market.source === "POLYMARKET" &&
    market.resolutionDeadline.getTime() <= Date.now()
  ) {
    // ponytail: one RPC read (3 eth_calls) per stuck market per tick, unbounded by count — fine at
    // today's volume (the scan reports a single market with pending bets), and the honest upgrade is
    // to cap the oldest N per tick if a backlog of undecided markets ever makes this a rate limit.
    resolution = chainToResolution(await conditionResolution(market.polymarketId)); // may throw -> transient
    if (resolution.kind !== "open") {
      console.log(`[settle] ${market.polymarketId.slice(0, 16)}… resolved from CHAIN (Gamma still open)`);
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
  // Keep the deck cache warm so swipes lock fresh prices and expired markets drop (M4).
  // Pull the OUTER window (max per-category horizon) to match the deck route — otherwise the
  // longer-horizon sports/esports half never gets price refreshes and shows stale (often 50/50)
  // odds. fetchBlitzDeck still drops each market past its own category horizon.
  try {
    const r = await refreshDeck(DECK_FETCH_HORIZON_HOURS, 100);
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
  } catch (e) {
    console.warn("[deck] refresh error:", (e as Error).message);
    subsystemFailed("deck", e);
  }

  // Hedge market index (S1 crypto majors + S2 sports/esports) — SLOWER sibling cadence (every Nth
  // tick). Runs on the FIRST tick after boot then every HEDGE_INDEX_EVERY_N_TICKS ticks, so a fresh
  // poller populates it promptly and it stays warm thereafter. Freshness kills the F1 snipe window
  // (a market resolved-early on Polymarket gets re-priced/closed here); F2's clear-pass drops rows
  // that fell out of the fetch/band. A refresh failure is transient — log and keep the tick alive.
  if ((tickCount - 1) % HEDGE_INDEX_EVERY_N_TICKS === 0) {
    try {
      const hs = await refreshHedgeIndex();
      console.log(
        `[hedge-index] S1 parsed=${hs.parsed}/${hs.discovered} | S2 eligible=${hs.sports.eligible}/${hs.sports.discovered} cleared=${hs.sports.clearedStale}`,
      );
      subsystemOk("hedge-index");
    } catch (e) {
      console.warn("[hedge-index] refresh error:", (e as Error).message);
      subsystemFailed("hedge-index", e);
    }
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
  const pending = await prisma.bet.findMany({
    where: { settlementStatus: "PENDING", market: { status: "OPEN" } },
    distinct: ["marketId"],
    select: { market: { select: { id: true, polymarketId: true, source: true, resolutionDeadline: true } } },
  });
  const markets = pending.map((p) => p.market);
  if (markets.length) {
    console.log(`[poll] ${markets.length} market(s) with pending bets`);
    let settleErrors = 0;
    await mapLimit(markets, CONCURRENCY, settleOne, () => { settleErrors++; });
    if (settleErrors > 0) subsystemFailed("settle", new Error(`${settleErrors} settle item error(s) this tick`));
    else subsystemOk("settle");
  }

  // Deposit watcher (plan §2.5): delta-based funding detection every tick; the lib applies the
  // tiered per-attempt cadence itself, so calling it each tick is cheap. RPC errors surface as a
  // subsystem failure only when NOTHING could be checked — per-attempt errors are counted inside.
  try {
    const f = await watchFunding(prisma, undefined, new Date(), rpcChain);
    if (f.checked + f.errors > 0) {
      console.log(`[funding] checked ${f.checked}, detected ${f.detected}, funded ${f.funded}, errors ${f.errors}`);
    }
    if (f.errors > 0 && f.checked === 0) subsystemFailed("funding", new Error(`${f.errors} watcher error(s), 0 checked`));
    else subsystemOk("funding");
  } catch (e) {
    console.warn("[funding] watcher error:", (e as Error).message);
    subsystemFailed("funding", e);
  }

  // REAL positions on markets that have already resolved. A LOST one redeems to zero, so it needs
  // no signature and no relayer — waiting for the user to open a developer console and press REDEEM
  // is not settlement, it is a position sitting "open" for hours after the match ended. Winners are
  // booked only once the collateral has demonstrably moved — the outcome token has left the wallet,
  // which is what Polymarket's auto-redeemer does with the operator right granted at activation.
  // Resolution alone is not proof, so the token balance is what the pass reads.
  // The same pass clears intents nobody signed — one such row holds the market's in-flight slot and
  // the intent route only expires it when a NEW intent arrives for that same market, which never
  // comes if the reason nobody retried is that the button correctly disappeared.
  try {
    const rs = await settleResolvedRealPositions(prisma);
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
      market: { resolutionDeadline: { lt: new Date(Date.now() - 6 * 3_600_000) } },
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
  while (running) {
    const start = Date.now();
    try {
      await tick();
      // Heartbeat only on a clean tick — a failed tick should let the file go stale so the
      // healthcheck eventually restarts us rather than masking a persistent failure.
      writeFileSync(HEARTBEAT_FILE, new Date().toISOString());
      // Dead-man ping: external uptime check; no-op without POLLER_HC_URL.
      const hc = process.env.POLLER_HC_URL;
      if (hc) fetch(hc, { signal: AbortSignal.timeout(5000) }).catch(() => {});
    } catch (e) {
      console.error("[poll] tick failed:", (e as Error).message);
      void captureToGlitchTip(e, { subsystem: "tick" });
    }
    const elapsed = Date.now() - start;
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
      prisma.$disconnect().then(() => process.exit(0));
    });
  }

  loop();
}
