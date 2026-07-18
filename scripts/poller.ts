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
import { settleMarket, type Resolution } from "./settle";
import { evaluateStreak } from "../src/lib/streak";
import { refreshDeck } from "./refresh-deck";
import { refreshFootball } from "./refresh-football";
import { resolveFootball } from "./settle-football";
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
let tickCount = 0;

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
  // Resolution source branches on the market: Polymarket via Gamma, TXODDS football via TxLINE scores.
  let resolution: Resolution;
  let onchainRef: string | null = null;
  if (market.source === "TXODDS") {
    const r = await resolveFootball(market.polymarketId, market.resolutionDeadline.getTime()); // may throw -> transient
    resolution = r.resolution;
    onchainRef = r.onchainRef;
  } else {
    resolution = toResolution(await fetchResolution(market.polymarketId)); // may throw -> transient
  }
  if (resolution.kind === "open") return;
  const r = await settleMarket(prisma, market.id, resolution);
  await prisma.market.update({
    where: { id: market.id },
    // TXODDS: stamp the Solana-anchored proof on the now-settled market (drives the ⛓ badge).
    data: { lastPolledAt: new Date(), ...(market.source === "TXODDS" ? { verifiedOnChain: true, onchainRef } : {}) },
  });
  if (r.settled + r.voided > 0) {
    console.log(
      `[settle] ${market.source} ${market.polymarketId.slice(0, 16)}… settled=${r.settled} void=${r.voided} shards=${r.shardsAwarded}`,
    );
  }
}

// Process an array with a bounded concurrency, isolating per-item errors.
// Exported so scripts/test-poller-maplimit.ts can unit-test the error-isolation + bounded
// concurrency in isolation (importing this module does NOT start loop() — see runAsDaemon guard).
export async function mapLimit<T>(items: T[], limit: number, fn: (t: T) => Promise<void>) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift()!;
      try {
        await fn(item);
      } catch (e) {
        console.warn("[poll] item error (will retry next tick):", (e as Error).message);
      }
    }
  });
  await Promise.all(workers);
}

async function tick() {
  // Keep the deck cache warm so swipes lock fresh prices and expired markets drop (M4).
  // Pull the OUTER window (max per-category horizon) to match the deck route — otherwise the
  // longer-horizon sports/esports half never gets price refreshes and shows stale (often 50/50)
  // odds. fetchBlitzDeck still drops each market past its own category horizon.
  try {
    const n = await refreshDeck(DECK_FETCH_HORIZON_HOURS, 100);
    console.log(`[deck] refreshed ${n} markets`);
  } catch (e) {
    console.warn("[deck] refresh error:", (e as Error).message);
  }

  // World Cup football O/U markets (TxLINE) — same cache table, mixed into the deck by the mixer.
  try {
    const fn = await refreshFootball();
    console.log(`[football] refreshed ${fn} World Cup markets`);
  } catch (e) {
    console.warn("[football] refresh error:", (e as Error).message);
  }

  // Hedge market index (S1 crypto majors + S2 sports/esports) — SLOWER sibling cadence (every Nth
  // tick). Runs on the FIRST tick after boot then every HEDGE_INDEX_EVERY_N_TICKS ticks, so a fresh
  // poller populates it promptly and it stays warm thereafter. Freshness kills the F1 snipe window
  // (a market resolved-early on Polymarket gets re-priced/closed here); F2's clear-pass drops rows
  // that fell out of the fetch/band. A refresh failure is transient — log and keep the tick alive.
  tickCount++;
  if ((tickCount - 1) % HEDGE_INDEX_EVERY_N_TICKS === 0) {
    try {
      const hs = await refreshHedgeIndex();
      console.log(
        `[hedge-index] S1 parsed=${hs.parsed}/${hs.discovered} | S2 eligible=${hs.sports.eligible}/${hs.sports.discovered} cleared=${hs.sports.clearedStale}`,
      );
    } catch (e) {
      console.warn("[hedge-index] refresh error:", (e as Error).message);
    }
  }

  // Markets that still have unsettled bets.
  const pending = await prisma.bet.findMany({
    where: { settlementStatus: "PENDING" },
    distinct: ["marketId"],
    select: { market: { select: { id: true, polymarketId: true, source: true, resolutionDeadline: true } } },
  });
  const markets = pending.map((p) => p.market);
  if (markets.length) {
    console.log(`[poll] ${markets.length} market(s) with pending bets`);
    await mapLimit(markets, CONCURRENCY, settleOne);
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
  for (const s of due) {
    try {
      await evaluateStreak(s.userId);
    } catch (e) {
      console.warn("[streak] sweep error:", (e as Error).message);
    }
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
    } catch (e) {
      console.error("[poll] tick failed:", (e as Error).message);
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
    process.exit(1);
  });
  process.on("uncaughtException", (err) => {
    console.error("[poll] uncaughtException:", err);
    process.exit(1);
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
