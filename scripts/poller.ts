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
import { DECK_FETCH_HORIZON_HOURS } from "../src/lib/deck-mix";
import { DECK_MIN_SERVABLE } from "../src/lib/config";
import { captureToGlitchTip, sendOpsTelegram } from "../src/lib/glitchtip";
import { settleMarket, type Resolution } from "./settle";
import { watchFunding } from "../src/lib/funding";
import { watchStuckAttempts } from "../src/lib/attempts-watch";
import { evaluateStreak } from "../src/lib/streak";
import { refreshDeck } from "./refresh-deck";
import { pruneMarkets } from "./prune-markets";
import { refreshHedgeIndex } from "./refresh-hedge-index";

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
let tickCount = 0;

// Silent-failure watch: subsystem errors are swallowed by design (a failed deck refresh
// must not kill settlement), so count consecutive failures and alert at 3. Reset on the
// first success; a recovery after an alert sends one OK message.
const FAIL_ALERT_AT = 3;
const failStreaks: Record<string, number> = {};
function subsystemFailed(name: string, e: unknown): void {
  failStreaks[name] = (failStreaks[name] ?? 0) + 1;
  void captureToGlitchTip(e, { subsystem: name });
  if (failStreaks[name] === FAIL_ALERT_AT) {
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

async function settleOne(market: { id: string; polymarketId: string; source: string; resolutionDeadline: Date }) {
  const resolution: Resolution = toResolution(await fetchResolution(market.polymarketId)); // may throw -> transient
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
    const f = await watchFunding(prisma);
    if (f.checked + f.errors > 0) {
      console.log(`[funding] checked ${f.checked}, detected ${f.detected}, funded ${f.funded}, errors ${f.errors}`);
    }
    if (f.errors > 0 && f.checked === 0) subsystemFailed("funding", new Error(`${f.errors} watcher error(s), 0 checked`));
    else subsystemOk("funding");
  } catch (e) {
    console.warn("[funding] watcher error:", (e as Error).message);
    subsystemFailed("funding", e);
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
      mode: "PAPER",
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
