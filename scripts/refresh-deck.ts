// Populate/refresh the Market cache from Polymarket so /api/deck reads the DB, not the
// live API per request. Run: npm run refresh-deck  (later: poller calls this each tick).
//
// D10: fetchBlitzDeck returns only markets that PASSED the depth gate (both books fill STAKE_CENTS
// within the eligibility cap, effective prices contested) with the executable numbers attached —
// we persist them verbatim. Markets that fail the gate on EITHER side are dropped (a card offers
// two swipe directions, so both must be tradable). Markets the gate EVALUATED and found UNTRADABLE
// also come back in `rejected` and get an explicit rejection stamp (1b: eff prices null, capacity 0,
// bookTsAt = now) so an already-cached row stops serving within this tick instead of lingering on
// stale eff prices until the display-staleness bound — and "read and untradable" (bookTsAt set, eff
// null) is distinguishable from "never read" (both null). Rows never evaluated are left untouched
// (fetchBlitzDeck breaks early once its buckets fill).
import { PrismaClient } from "@prisma/client";
import { fetchBlitzDeck } from "../src/lib/polymarket";
import {
  DECK_FETCH_HORIZON_HOURS,
  categoryOf,
  isContextPoor,
  isUnnamedMatch,
  shuffleNoRun,
  withinCategoryHorizon,
} from "../src/lib/deck-mix";
import { servableUpDown } from "../src/lib/updown";
import { evalMarketDepthBatch } from "../src/lib/depth";
import { DECK_MIN_LEAD_MS } from "../src/lib/config";

const prisma = new PrismaClient();

// What a refresh actually achieved. `upserted` is how many rows we wrote; `servable` is how many of
// them a user could still be DEALT once the DECK_MIN_LEAD_MS buffer is applied.
//
// Those two numbers diverged catastrophically on prod (2026-07-30) and only `upserted` was logged:
// every tick cheerfully reported "refreshed 100 markets" while all 100 expired within the hour, so
// the live deck held ~26 cards and users saw an empty screen for weeks. Counting the wrong thing is
// what made a gradual degradation invisible — so the poller now reports BOTH and alarms on the one
// that matters.
export interface RefreshResult {
  upserted: number;
  servable: number;
}

export async function refreshDeck(hours = DECK_FETCH_HORIZON_HOURS, limit = 100): Promise<RefreshResult> {
  const { deck: markets, rejected } = await fetchBlitzDeck(hours, limit);
  for (const m of markets) {
    await prisma.market.upsert({
      where: { polymarketId: m.polymarketId },
      create: {
        polymarketId: m.polymarketId,
        question: m.question,
        category: m.category,
        league: m.league, // which sport / which game — from Gamma's tags, see MarketCache.league
        outcomeYesLabel: m.outcomeYesLabel,
        outcomeNoLabel: m.outcomeNoLabel,
        yesPriceBp: m.yesPriceBp,
        noPriceBp: m.noPriceBp,
        yesTokenId: m.yesTokenId,
        noTokenId: m.noTokenId,
        yesEffPriceBp: m.yesEffPriceBp,
        noEffPriceBp: m.noEffPriceBp,
        yesMaxStakeCents: m.yesMaxStakeCents,
        noMaxStakeCents: m.noMaxStakeCents,
        bookTsAt: m.bookTsAt ? new Date(m.bookTsAt) : null,
        startsAt: m.startsAt ? new Date(m.startsAt) : null,
        resolutionDeadline: new Date(m.resolutionDeadline),
        status: m.status,
      },
      update: {
        league: m.league, // backfills rows cached before tags were read
        outcomeYesLabel: m.outcomeYesLabel,
        outcomeNoLabel: m.outcomeNoLabel,
        yesPriceBp: m.yesPriceBp,
        noPriceBp: m.noPriceBp,
        yesTokenId: m.yesTokenId,
        noTokenId: m.noTokenId,
        yesEffPriceBp: m.yesEffPriceBp,
        noEffPriceBp: m.noEffPriceBp,
        yesMaxStakeCents: m.yesMaxStakeCents,
        noMaxStakeCents: m.noMaxStakeCents,
        bookTsAt: m.bookTsAt ? new Date(m.bookTsAt) : null,
        startsAt: m.startsAt ? new Date(m.startsAt) : null,
        resolutionDeadline: new Date(m.resolutionDeadline),
        // status is deliberately NOT written on update. fetchBlitzDeck filters to status === "OPEN"
        // (polymarket.ts), so this only ever wrote back "OPEN" — and writing it unconditionally
        // regresses a market the poller has already settled: a stale/lagging Gamma payload flips a
        // RESOLVED or CANCELED row back to OPEN while resolvedOutcome stays set, which breaks
        // planRedeem's terminal guard and re-admits a decided market to the deck. Terminal
        // transitions belong to the poller; create (above) still stamps the initial status.
        lastPolledAt: new Date(),
      },
    });
  }
  // 1b rejection stamp: ONLY rows the gate evaluated and found untradable. updateMany (not upsert)
  // on purpose — there is nothing to CREATE: a rejected market that was never persisted has no stale
  // state to clear and nothing serves it. Absent ids no-op.
  if (rejected.length > 0) {
    const stamped = await prisma.market.updateMany({
      where: { polymarketId: { in: rejected } },
      data: {
        yesEffPriceBp: null,
        noEffPriceBp: null,
        yesMaxStakeCents: 0,
        noMaxStakeCents: 0,
        bookTsAt: new Date(), // "read and untradable" NOW — not the book's ts: this marks the verdict
      },
    });
    if (stamped.count > 0) console.log(`refresh-deck: stamped ${stamped.count} gate-rejected market(s) untradable`);
  }
  // Measure against the SERVE rule, not the fetch rule: a market inside the lead buffer is cached
  // but undealable, so it must not count as inventory. `markets` is already depth-gated here, so
  // this counts cards that are BOTH tradable and long-lived enough to deal — the honest number.
  const cutoff = Date.now() + DECK_MIN_LEAD_MS;
  const servable = markets.filter((m) => new Date(m.resolutionDeadline).getTime() > cutoff).length;
  return { upserted: markets.length, servable };
}

// refreshDeck re-reads the same ~200 soonest-ending markets every tick, and the deck drops any row
// whose book is older than BOOK_MAX_DISPLAY_STALE_MS (10 min) — so whole leagues never reached the
// deck (2026-10-03: 137 contested Tennis markets, 1 fresh book). This re-reads books for a
// league-spread sample of cached rows whose book is missing or >5 min old. Every evaluated row gets
// its true numbers (out-of-band ones too: the serve-time band filter drops them, and a fresh stamp
// keeps them from being re-picked next tick); untradable rows get the same stamp refreshDeck writes.
export async function refreshStaleBooks(limit = 150): Promise<{ picked: number; fresh: number; stamped: number }> {
  const nowMs = Date.now();
  const candidates = await prisma.market.findMany({
    where: {
      status: "OPEN",
      source: "POLYMARKET",
      yesTokenId: { not: null },
      noTokenId: { not: null },
      resolutionDeadline: {
        gt: new Date(nowMs + DECK_MIN_LEAD_MS),
        lte: new Date(nowMs + DECK_FETCH_HORIZON_HOURS * 3_600_000),
      },
      OR: [{ bookTsAt: null }, { bookTsAt: { lt: new Date(nowMs - 5 * 60_000) } }],
    },
    select: {
      id: true,
      question: true,
      category: true,
      league: true,
      outcomeYesLabel: true,
      outcomeNoLabel: true,
      yesTokenId: true,
      noTokenId: true,
      resolutionDeadline: true,
    },
    take: 5000,
  });

  const rows = candidates.filter((m) => {
    const deadlineMs = m.resolutionDeadline.getTime();
    return (
      !isContextPoor(m) &&
      !isUnnamedMatch(m) &&
      servableUpDown(m.question, deadlineMs, nowMs) &&
      withinCategoryHorizon(m, deadlineMs, nowMs)
    );
  });

  const picked = shuffleNoRun(rows, (m) => m.league ?? categoryOf(m), limit, nowMs & 0x7fffffff);
  if (picked.length === 0) return { picked: 0, fresh: 0, stamped: 0 };

  const depth = await evalMarketDepthBatch(
    picked.map((m) => ({ key: m.id, yesTokenId: m.yesTokenId, noTokenId: m.noTokenId })),
  );

  let fresh = 0;
  const rejects: string[] = [];
  for (const m of picked) {
    const d = depth.get(m.id) ?? null;
    if (d === null) continue; // CLOB down / no tokens — no verdict, write nothing
    if (!d.tradable || d.yesEffPriceBp === null || d.noEffPriceBp === null) {
      rejects.push(m.id);
      continue;
    }
    await prisma.market.update({
      where: { id: m.id },
      data: {
        yesEffPriceBp: d.yesEffPriceBp,
        noEffPriceBp: d.noEffPriceBp,
        yesMaxStakeCents: d.yesMaxStakeCents,
        noMaxStakeCents: d.noMaxStakeCents,
        bookTsAt: d.bookTsAtMs !== null ? new Date(d.bookTsAtMs) : null,
      },
    });
    fresh++;
  }

  let stamped = 0;
  if (rejects.length > 0) {
    const res = await prisma.market.updateMany({
      where: { id: { in: rejects } },
      data: { yesEffPriceBp: null, noEffPriceBp: null, yesMaxStakeCents: 0, noMaxStakeCents: 0, bookTsAt: new Date() },
    });
    stamped = res.count;
  }
  return { picked: picked.length, fresh, stamped };
}

// Run directly (not when imported by the poller).
if (process.argv[1] && process.argv[1].endsWith("refresh-deck.ts")) {
  refreshDeck()
    .then((r) => {
      console.log(`refresh-deck: upserted ${r.upserted} markets (${r.servable} servable)`);
      return prisma.$disconnect();
    })
    .catch((e) => {
      console.error("refresh-deck failed:", e);
      process.exit(1);
    });
}
