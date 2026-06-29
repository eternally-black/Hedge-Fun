// Generate/refresh the football (World Cup) betting deck from TxLINE: one binary Over/Under-goals
// Market per line (1.5/2.5/3.5) per fixture, source=TXODDS, so they flow through the SAME
// deck/swipe/settle/history pipeline as Polymarket markets (crypto-backfill is automatic — they mix
// into the main deck). Run: npm run refresh-football. The poller calls this each tick.
import { PrismaClient } from "@prisma/client";
import { fetchFixtures, fetchOuMarkets, OU_KIND, WC_COMPETITION_ID } from "../src/lib/txodds";

const prisma = new PrismaClient();

// O/U total-goals markets settle at full time; give a cushion past 90' for stoppage/half-time so a
// live, still-contested line stays serveable until it's genuinely near-decided. resolutionDeadline
// also doubles as the poller's "regulation done" settle mark (see settle-football.ts).
const SETTLE_WINDOW_MIN = 150;

export async function refreshFootball(): Promise<number> {
  let fixtures;
  try {
    fixtures = await fetchFixtures();
  } catch (e) {
    console.warn("[football] fixtures error:", (e as Error).message);
    return 0;
  }
  const wc = fixtures.filter((f) => f.CompetitionId === WC_COMPETITION_ID);

  let count = 0;
  for (const f of wc) {
    const kickoffMs = f.StartTime;
    const endMs = kickoffMs + SETTLE_WINDOW_MIN * 60_000;
    // Don't keep generating long-ended fixtures (settlement already handled them).
    if (Date.now() > endMs + 6 * 3_600_000) continue;

    let lines;
    try {
      lines = await fetchOuMarkets(f.FixtureId);
    } catch (e) {
      console.warn(`[football] odds error for fixture ${f.FixtureId}:`, (e as Error).message);
      continue; // transient per-fixture odds error — try again next tick
    }

    for (const m of lines) {
      const polymarketId = `txline:${f.FixtureId}:${OU_KIND[m.line]}`;
      const question = `World Cup — ${f.Participant1} vs ${f.Participant2}: Over ${m.line} goals?`;
      await prisma.market.upsert({
        where: { polymarketId },
        create: {
          polymarketId,
          source: "TXODDS",
          question,
          category: "sports", // "World Cup" in the question → categoryOf=sports, gameOf=Soccer
          outcomeYesLabel: "Over",
          outcomeNoLabel: "Under",
          yesPriceBp: m.overBp,
          noPriceBp: m.underBp,
          startsAt: new Date(kickoffMs),
          resolutionDeadline: new Date(endMs),
          status: "OPEN",
        },
        update: {
          yesPriceBp: m.overBp,
          noPriceBp: m.underBp,
          resolutionDeadline: new Date(endMs),
          lastPolledAt: new Date(),
        },
      });
      count++;
    }
  }
  return count;
}

// Run directly (not when imported by the poller).
if (process.argv[1] && process.argv[1].endsWith("refresh-football.ts")) {
  refreshFootball()
    .then((n) => {
      console.log(`refresh-football: upserted ${n} World Cup O/U markets`);
      return prisma.$disconnect();
    })
    .catch((e) => {
      console.error("refresh-football failed:", e);
      process.exit(1);
    });
}
