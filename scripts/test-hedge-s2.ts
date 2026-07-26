// DB-backed end-to-end check for the S2 life-event hedge (test-hedge-accept style). Seeds S2-eligible
// NAMED sports markets, then asserts:
//   - getPickers() groups the seeded teams under their league (only entities with an open market)
//   - searchS2("Lakers") returns an AGAINST suggestion (bet the opposite side), NOT discovery
//   - accepting an S2 suggestion creates a source=HEDGE Bet, held vs Cash, idempotent, and it rides
//     the EXISTING settlement poller unchanged
//   - a no-match query falls to the discovery fallback (is_discovery=true), and a fallback card accepts
//   - impression/dismiss telemetry is idempotent for an S2 id
// NLU is NOT exercised here (no ANTHROPIC_API_KEY in the test env -> deterministic path only).
// Needs DATABASE_URL (Docker DB). Run: npx tsx scripts/test-hedge-s2.ts
import assert from "node:assert";
import { prisma } from "../src/lib/prisma";
import { randomCode } from "../src/lib/refcode";
import { getPickers, searchS2 } from "../src/lib/hedge/s2";
import { acceptSuggestion } from "../src/lib/hedge/accept";
import { recordSuggestionEvent } from "../src/lib/hedge/telemetry";
import { HEDGE_S2_STAKE_CENTS } from "../src/lib/config";
import { settleMarket } from "./settle";

async function makeUser(tag: string, balanceCents: number) {
  return prisma.user.create({
    data: {
      privyId: `did:privy:${tag}`,
      authProvider: "EMAIL",
      referralCode: randomCode(),
      virtualBalance: { create: { balanceCents } },
      collectibleBalance: { create: {} },
      streak: { create: {} },
    },
  });
}

// Seed one OPEN, contested, NAMED sports market + its S2-eligible MarketMeta enrichment.
// source: TXODDS keeps the seed on the SYNTHETIC price-lock path (D10): accept now re-quotes the
// live CLOB book for POLYMARKET rows, and a hermetic DB test has no book to quote. The S2 derive/
// accept pipeline is source-agnostic (eligibility lives on MarketMeta); the re-quote branch is
// covered DB-free by test-clob.ts / test-depth-gate.ts.
async function seedS2Market(opts: {
  tag: string;
  yesLabel: string;
  noLabel: string;
  yesBp: number;
  noBp: number;
  leagueSlug: string;
  leagueLabel: string;
  sportKind: string;
  hoursOut: number;
}) {
  const market = await prisma.market.create({
    data: {
      polymarketId: opts.tag,
      question: `${opts.yesLabel} vs ${opts.noLabel}`,
      source: "TXODDS",
      outcomeYesLabel: opts.yesLabel,
      outcomeNoLabel: opts.noLabel,
      yesPriceBp: opts.yesBp,
      noPriceBp: opts.noBp,
      startsAt: new Date(Date.now() + 30 * 60_000),
      resolutionDeadline: new Date(Date.now() + opts.hoursOut * 3_600_000),
      status: "OPEN",
    },
  });
  await prisma.marketMeta.create({
    data: {
      marketId: market.id,
      s2Eligible: true,
      sportKind: opts.sportKind,
      leagueSlug: opts.leagueSlug,
      leagueLabel: opts.leagueLabel,
      parsedDeadline: market.resolutionDeadline,
      liquidityCents: 500_000,
    },
  });
  return market;
}

async function main() {
  const tag = `hedges2-${process.pid}-${Date.now() & 0xffffff}`;

  const nba = await seedS2Market({
    tag: `${tag}-nba`,
    yesLabel: "Los Angeles Lakers",
    noLabel: "Boston Celtics",
    yesBp: 4500,
    noBp: 5500,
    leagueSlug: `${tag}-nba`,
    leagueLabel: `NBA ${tag}`,
    sportKind: "sports",
    hoursOut: 3,
  });
  const soccer = await seedS2Market({
    tag: `${tag}-soccer`,
    yesLabel: "Barcelona",
    noLabel: "Real Madrid",
    yesBp: 5000,
    noBp: 5000,
    leagueSlug: `${tag}-soccer`,
    leagueLabel: `Soccer ${tag}`,
    sportKind: "sports",
    hoursOut: 24,
  });

  // ── Pickers: our leagues + teams appear (only entities with an open market). ──────────────────────
  const pickers = await getPickers();
  const nbaLeague = pickers.leagues.find((l) => l.slug === `${tag}-nba`);
  assert.ok(nbaLeague, "seeded NBA league present in pickers");
  assert.deepStrictEqual([...nbaLeague!.teams].sort(), ["Boston Celtics", "Los Angeles Lakers"], "NBA teams listed");
  const soccerLeague = pickers.leagues.find((l) => l.slug === `${tag}-soccer`);
  assert.ok(soccerLeague, "seeded soccer league present");
  assert.ok(soccerLeague!.teams.includes("Barcelona") && soccerLeague!.teams.includes("Real Madrid"), "soccer teams listed");

  // ── Search: "Lakers" -> AGAINST suggestion on the NBA market (bet the OPPOSITE side). ─────────────
  const userA = await makeUser(`${tag}-a`, 20_000);
  const found = await searchS2("Lakers");
  assert.strictEqual(found.isDiscovery, false, "a matched query is NOT discovery");
  assert.strictEqual(found.usedNlu, false, "no NLU without a key (deterministic path)");
  const sug = found.suggestions.find((s) => s.id === nba.id);
  assert.ok(sug, "Lakers -> the NBA market suggestion");
  assert.strictEqual(sug!.kind, "S2", "kind is S2");
  assert.strictEqual(sug!.side, "NO", "support Lakers (YES) -> hedge the NO (Celtics) side");
  assert.strictEqual(sug!.sideLabel, "Boston Celtics", "hedge side label = the opponent");
  assert.strictEqual(sug!.matchedEntity, "Los Angeles Lakers", "matched entity = the team you support");
  assert.strictEqual(sug!.proposedStakeCents, HEDGE_S2_STAKE_CENTS, "fixed S2 stake (no notional to size)");
  assert.strictEqual(sug!.isDiscovery, false, "S2 card is not discovery");

  // ── Accept: a source=HEDGE bet with the fixed stake, held vs Cash, on the hedge side. ────────────
  const acc = await acceptSuggestion(userA.id, sug!.suggestionId);
  assert.strictEqual(acc.alreadyAccepted, false, "first accept is fresh");
  assert.strictEqual(acc.stakeCents, HEDGE_S2_STAKE_CENTS, "accepted at the fixed S2 stake");
  const bet = await prisma.bet.findUniqueOrThrow({ where: { id: acc.betId } });
  assert.strictEqual(bet.source, "HEDGE", "bet source = HEDGE");
  assert.strictEqual(bet.side, "NO", "bet side = NO (the against side)");
  assert.strictEqual(bet.marketId, nba.id, "bet on the NBA market");
  assert.strictEqual(bet.lockedPriceBp, 5500, "locked the live NO price");
  assert.strictEqual(bet.hedgeSuggestionId, sug!.suggestionId, "bet back-references the S2 suggestion");
  let vbA = await prisma.virtualBalance.findUniqueOrThrow({ where: { userId: userA.id } });
  assert.strictEqual(vbA.lockedCents, HEDGE_S2_STAKE_CENTS, "stake is HELD");
  const acceptEvt = await prisma.hedgeSuggestionEvent.findUniqueOrThrow({
    where: { userId_suggestionId_event: { userId: userA.id, suggestionId: sug!.suggestionId, event: "ACCEPT" } },
  });
  assert.strictEqual(acceptEvt.kind, "S2", "ACCEPT telemetry records kind S2");
  assert.strictEqual(acceptEvt.betId, acc.betId, "ACCEPT telemetry records the bet");

  // ── Idempotency: re-accept returns the same bet, no second hold. ─────────────────────────────────
  const acc2 = await acceptSuggestion(userA.id, sug!.suggestionId);
  assert.strictEqual(acc2.alreadyAccepted, true, "re-accept is idempotent");
  assert.strictEqual(acc2.betId, acc.betId, "same bet id");
  assert.strictEqual(await prisma.bet.count({ where: { userId: userA.id } }), 1, "no duplicate bet");

  // ── Telemetry idempotency for the S2 id. ─────────────────────────────────────────────────────────
  assert.strictEqual(await recordSuggestionEvent(userA.id, sug!.suggestionId, "IMPRESSION"), true, "impression recorded");
  assert.strictEqual(await recordSuggestionEvent(userA.id, sug!.suggestionId, "IMPRESSION"), true, "impression idempotent");
  assert.strictEqual(
    await prisma.hedgeSuggestionEvent.count({ where: { userId: userA.id, suggestionId: sug!.suggestionId, event: "IMPRESSION" } }),
    1,
    "one impression row",
  );

  // ── Fallback: a no-match query -> discovery cards (is_discovery=true), which still accept. ────────
  const userB = await makeUser(`${tag}-b`, 20_000);
  const disc = await searchS2(`zzq ${tag} nomatchxyz`);
  assert.strictEqual(disc.isDiscovery, true, "no match -> discovery fallback");
  assert.strictEqual(disc.matchedEntity, null, "fallback has no matched entity");
  assert.ok(disc.suggestions.length > 0, "fallback returns at least one discovery card");
  const fb = disc.suggestions[0];
  assert.strictEqual(fb.kind, "fallback", "fallback card kind = fallback");
  assert.strictEqual(fb.isDiscovery, true, "fallback card flagged discovery");
  const accFb = await acceptSuggestion(userB.id, fb.suggestionId);
  const betFb = await prisma.bet.findUniqueOrThrow({ where: { id: accFb.betId } });
  assert.strictEqual(betFb.source, "HEDGE", "fallback accept -> HEDGE bet");
  assert.strictEqual(betFb.marketId, fb.id, "fallback bet on the discovery market");

  // ── Settlement: the S2 hedge rides the EXISTING poller. Resolve NO -> the NO (against) bet WINS. ──
  await settleMarket(prisma, nba.id, { kind: "resolved", resolvedYes: false });
  const settled = await prisma.bet.findUniqueOrThrow({ where: { id: acc.betId } });
  assert.strictEqual(settled.settlementStatus, "SETTLED", "S2 hedge settled by the standard path");
  assert.strictEqual(settled.result, "WIN", "NO (against Lakers) bet wins when the market resolves NO");
  vbA = await prisma.virtualBalance.findUniqueOrThrow({ where: { userId: userA.id } });
  assert.strictEqual(vbA.lockedCents, 0, "hold released on settlement");
  assert.ok(vbA.balanceCents > 20_000, "winning payout credited");

  // ── cleanup (children before parents) ────────────────────────────────────────────────────────────
  // Only delete OUR seeded markets — the fallback bet may sit on an external cache market (real
  // discovery pool), so we drop the bet but never the market it belongs to.
  const userIds = [userA.id, userB.id];
  const marketIds = [nba.id, soccer.id];
  await prisma.shardGrant.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.dailyCounter.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.hedgeSuggestionEvent.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.bet.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.marketMeta.deleteMany({ where: { marketId: { in: marketIds } } });
  await prisma.market.deleteMany({ where: { id: { in: marketIds } } });
  await prisma.virtualBalance.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.collectibleBalance.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.streak.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });

  console.log("OK: hedge S2 — pickers, against-side search, accept+settle via the standard poller, discovery fallback");
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); }).finally(() => prisma.$disconnect());
