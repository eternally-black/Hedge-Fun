// Generate/refresh the football (World Cup) betting deck from TxLINE: one binary Over/Under-goals
// Market per line (1.5/2.5/3.5) per fixture, source=TXODDS, so they flow through the SAME
// deck/swipe/settle/history pipeline as Polymarket markets (crypto-backfill is automatic — they mix
// into the main deck). Run: npm run refresh-football. The poller calls this each tick.
import { PrismaClient } from "@prisma/client";
import { fetchFixtures, fetchOdds, parseOuMarkets, parseWinMarkets, OU_KIND, WIN_KIND, WC_COMPETITION_ID } from "../src/lib/txodds";

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

    let odds;
    try {
      odds = await fetchOdds(f.FixtureId); // one fetch → both market kinds (O/U goals + 1X2 win)
    } catch (e) {
      console.warn(`[football] odds error for fixture ${f.FixtureId}:`, (e as Error).message);
      continue; // transient per-fixture odds error — try again next tick
    }
    const matchup = `World Cup — ${f.Participant1} vs ${f.Participant2}`; // keeps "World Cup" → categoryOf=sports

    // Binary Over/Under TOTAL GOALS, one per line (1.5/2.5/3.5).
    for (const m of parseOuMarkets(odds)) {
      await upsertMarket(
        `txline:${f.FixtureId}:${OU_KIND[m.line]}`,
        `${matchup}: Over ${m.line} goals?`,
        "Over",
        "Under",
        m.overBp,
        m.underBp,
        kickoffMs,
        endMs,
      );
      count++;
    }

    // Binary "{team} to win?" from the 1X2 line (YES = team wins; NO = draw or the other team).
    for (const w of parseWinMarkets(odds)) {
      const team = w.team === "home" ? f.Participant1 : f.Participant2;
      await upsertMarket(
        `txline:${f.FixtureId}:${WIN_KIND[w.team]}`,
        `${matchup}: ${team} to win?`,
        "Yes",
        "No",
        w.winBp,
        10000 - w.winBp,
        kickoffMs,
        endMs,
      );
      count++;
    }
  }
  return count;
}

// Upsert one TXODDS binary market (refresh price + deadline on conflict; never re-open a settled row).
async function upsertMarket(
  polymarketId: string,
  question: string,
  yesLabel: string,
  noLabel: string,
  yesPriceBp: number,
  noPriceBp: number,
  kickoffMs: number,
  endMs: number,
): Promise<void> {
  await prisma.market.upsert({
    where: { polymarketId },
    create: {
      polymarketId,
      source: "TXODDS",
      question,
      category: "sports",
      outcomeYesLabel: yesLabel,
      outcomeNoLabel: noLabel,
      yesPriceBp,
      noPriceBp,
      startsAt: new Date(kickoffMs),
      resolutionDeadline: new Date(endMs),
      status: "OPEN",
    },
    update: {
      yesPriceBp,
      noPriceBp,
      resolutionDeadline: new Date(endMs),
      lastPolledAt: new Date(),
    },
  });
}

// Run directly (not when imported by the poller).
if (process.argv[1] && process.argv[1].endsWith("refresh-football.ts")) {
  refreshFootball()
    .then((n) => {
      console.log(`refresh-football: upserted ${n} World Cup markets (O/U goals + win)`);
      return prisma.$disconnect();
    })
    .catch((e) => {
      console.error("refresh-football failed:", e);
      process.exit(1);
    });
}
