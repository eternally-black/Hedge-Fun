// Feed economics in ONE process: a FEED bet earns NO points, does NOT touch the daily swipe counter,
// is NOT capped, but still locks the $10 stake — and on a win earns shards UNCAPPED (off the deck's
// SHARD_DAILY_CAP ledger). A single DECK bet is the control: it DOES earn a point, bump swipeCount,
// and consume a shard-cap slot. Run: npx tsx scripts/test-feed-bet.ts
import assert from "node:assert";
import { prisma } from "../src/lib/prisma";
import { recordSwipe } from "../src/lib/swipe";
import { settleMarket } from "./settle";
import { STAKE_CENTS, SHARD_DAILY_CAP } from "../src/lib/config";
import { randomCode } from "../src/lib/refcode";

const FEED_WINS = SHARD_DAILY_CAP + 2; // 12 — deliberately PAST the deck's daily shard cap

async function main() {
  const tag = `feedtest-${process.pid}-${Date.now() & 0xffffff}`;
  const start = (FEED_WINS + 5) * STAKE_CENTS; // cover 1 deck + 12 feed simultaneous holds
  const user = await prisma.user.create({
    data: {
      privyId: `did:privy:${tag}`, authProvider: "EMAIL", referralCode: randomCode(),
      virtualBalance: { create: { balanceCents: start } }, collectibleBalance: { create: {} }, streak: { create: {} },
    },
  });
  const mk = async (i: number) => prisma.market.create({
    data: { polymarketId: `${tag}-m${i}`, question: `q${i}`, status: "OPEN", yesPriceBp: 4000, noPriceBp: 6000, resolutionDeadline: new Date(Date.now() + 3_600_000) },
  });
  const deckMk = await mk(0);
  const feedMks = [];
  for (let i = 1; i <= FEED_WINS; i++) feedMks.push(await mk(i));

  // ── DECK control: earns a point, bumps swipeCount, holds the stake ───────────────────────────
  const deckRes = await recordSwipe({ userId: user.id, marketId: deckMk.id, side: "YES", lockedPriceBp: 4000 });
  const deckBet = await prisma.bet.findUniqueOrThrow({ where: { id: deckRes.betId } });
  assert.strictEqual(deckBet.source, "DECK", "deck bet source=DECK");
  assert.strictEqual(deckBet.earnedPoint, true, "deck bet earned a point");
  assert.strictEqual(deckRes.pointsAwarded, 1, "deck bet pointsAwarded=1");
  assert.strictEqual(await prisma.pointsLedger.count({ where: { betId: deckBet.id } }), 1, "deck bet wrote 1 SWIPE point");
  let counter = await prisma.dailyCounter.findFirstOrThrow({ where: { userId: user.id } });
  assert.strictEqual(counter.swipeCount, 1, "deck bet bumped swipeCount to 1");

  // ── FEED bets: NO points, NO counter movement, NO cap, but DO hold the stake ─────────────────
  const feedBetIds: string[] = [];
  for (const m of feedMks) {
    const r = await recordSwipe({ userId: user.id, marketId: m.id, side: "YES", lockedPriceBp: 4000, source: "FEED" });
    feedBetIds.push(r.betId);
    assert.strictEqual(r.pointsAwarded, 0, "feed bet pointsAwarded=0");
    assert.strictEqual(r.swipeCountToday, 0, "feed bet reports swipeCountToday=0 (counter untouched)");
  }
  for (const id of feedBetIds) {
    const b = await prisma.bet.findUniqueOrThrow({ where: { id } });
    assert.strictEqual(b.source, "FEED", "feed bet source=FEED");
    assert.strictEqual(b.earnedPoint, false, "feed bet earnedPoint=false");
  }
  assert.strictEqual(await prisma.pointsLedger.count({ where: { betId: { in: feedBetIds } } }), 0, "feed bets wrote ZERO points");
  // swipeCount STILL 1 — the 12 feed bets never touched the point-earning counter (no cap, either).
  counter = await prisma.dailyCounter.findFirstOrThrow({ where: { userId: user.id } });
  assert.strictEqual(counter.swipeCount, 1, "feed bets did NOT bump swipeCount");
  assert.strictEqual(await prisma.bet.count({ where: { userId: user.id } }), FEED_WINS + 1, "all feed bets stored — feed is uncapped");
  const vb1 = await prisma.virtualBalance.findUniqueOrThrow({ where: { userId: user.id } });
  assert.strictEqual(vb1.lockedCents, (FEED_WINS + 1) * STAKE_CENTS, "every feed bet held the $10 stake (same as a swipe)");

  // ── Settle all 12 feed wins → shards UNCAPPED, and the deck shard ledger stays untouched ─────
  for (const m of feedMks) await settleMarket(prisma, m.id, { kind: "resolved", resolvedYes: true });
  const cb1 = await prisma.collectibleBalance.findUniqueOrThrow({ where: { userId: user.id } });
  assert.strictEqual(cb1.shards, FEED_WINS, `feed granted ${FEED_WINS} shards — PAST the ${SHARD_DAILY_CAP}/day cap`);
  assert.ok(cb1.shards > SHARD_DAILY_CAP, "feed shard total exceeds the deck daily cap (uncapped)");
  assert.strictEqual(await prisma.shardGrant.count({ where: { userId: user.id, counted: true } }), FEED_WINS, "all feed wins counted=true");
  counter = await prisma.dailyCounter.findFirstOrThrow({ where: { userId: user.id } });
  assert.strictEqual(counter.shardCount, 0, "feed wins did NOT consume the deck's shardCount cap ledger");

  // ── Settle the 1 deck win → it DOES consume a cap slot, on top of the feed shards ────────────
  await settleMarket(prisma, deckMk.id, { kind: "resolved", resolvedYes: true });
  counter = await prisma.dailyCounter.findFirstOrThrow({ where: { userId: user.id } });
  assert.strictEqual(counter.shardCount, 1, "deck win bumped shardCount to 1 (capped path)");
  const cb2 = await prisma.collectibleBalance.findUniqueOrThrow({ where: { userId: user.id } });
  assert.strictEqual(cb2.shards, FEED_WINS + 1, "deck shard stacks on top of the feed shards");

  // cleanup (children before parents: ShardGrant FK → Bet, so shards first)
  await prisma.shardGrant.deleteMany({ where: { userId: user.id } });
  await prisma.bet.deleteMany({ where: { userId: user.id } });
  await prisma.pointsLedger.deleteMany({ where: { userId: user.id } });
  await prisma.dailyCounter.deleteMany({ where: { userId: user.id } });
  await prisma.market.deleteMany({ where: { polymarketId: { startsWith: `${tag}-m` } } });
  await prisma.virtualBalance.deleteMany({ where: { userId: user.id } });
  await prisma.collectibleBalance.deleteMany({ where: { userId: user.id } });
  await prisma.streak.deleteMany({ where: { userId: user.id } });
  await prisma.user.delete({ where: { id: user.id } });

  console.log("OK: feed bets points-off + counter-untouched + uncapped, shards uncapped & off the cap ledger; deck control correct");
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); }).finally(() => prisma.$disconnect());
