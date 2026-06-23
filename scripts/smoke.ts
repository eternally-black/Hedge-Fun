// End-to-end smoke test of the daily loop against the LIVE DB + LIVE Polymarket.
// Bypasses Privy (no keys yet) by creating a user directly. Run: npx tsx scripts/smoke.ts
//
// Exercises: provision -> GM (login+streak) -> refresh deck (real markets) -> swipes
// (cap + over-cap) -> manual market resolution -> settle (P&L + shard) -> idempotency
// (re-settle is a no-op) -> /me snapshot via effectivePoints.
import assert from "node:assert";
import { PrismaClient } from "@prisma/client";
import { START_BALANCE_CENTS, SWIPE_CAP, LOGIN_BONUS } from "../src/lib/config";
import { recordLogin } from "../src/lib/login";
import { qualifyDay } from "../src/lib/streak";
import { recordSwipe } from "../src/lib/swipe";
import { effectivePoints } from "../src/lib/points";
import { settleMarket, computePnl } from "./settle";

const prisma = new PrismaClient();
const TAG = "smoke-user"; // privyId prefix so we can clean up

async function cleanup() {
  const users = await prisma.user.findMany({ where: { privyId: { startsWith: TAG } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    // delete dependents first (no cascade configured — see L5)
    await prisma.shardGrant.deleteMany({ where: { userId: { in: ids } } });
    await prisma.pointsLedger.deleteMany({ where: { userId: { in: ids } } });
    await prisma.bet.deleteMany({ where: { userId: { in: ids } } });
    await prisma.loginMark.deleteMany({ where: { userId: { in: ids } } });
    await prisma.dailyCounter.deleteMany({ where: { userId: { in: ids } } });
    await prisma.streakEvent.deleteMany({ where: { userId: { in: ids } } });
    await prisma.streak.deleteMany({ where: { userId: { in: ids } } });
    await prisma.collectibleBalance.deleteMany({ where: { userId: { in: ids } } });
    await prisma.virtualBalance.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  // synthetic markets seeded by this smoke
  await prisma.market.deleteMany({ where: { polymarketId: { startsWith: `${TAG}-mkt-` } } });
}

async function main() {
  await cleanup();

  // 1. Provision a user the way ensureUser would.
  const privyId = `${TAG}-${process.pid}`;
  const user = await prisma.user.create({
    data: {
      privyId,
      authProvider: "EMAIL",
      email: `${privyId}@test.local`,
      virtualBalance: { create: { balanceCents: START_BALANCE_CENTS } },
      collectibleBalance: { create: {} },
      streak: { create: {} },
    },
  });
  console.log("1. provisioned user", user.id.slice(0, 8), "balance", START_BALANCE_CENTS);

  // 2. GM: login bonus + streak day (login + deck legs).
  const login = await recordLogin(user.id);
  assert.strictEqual(login.awarded, true, "first GM awards login bonus");
  assert.strictEqual(login.amount, LOGIN_BONUS);
  const again = await recordLogin(user.id);
  assert.strictEqual(again.awarded, false, "second GM same day is idempotent");
  const streak = await qualifyDay(user.id);
  assert.strictEqual(streak.qualifiedToday, true, "GM qualifies the day");
  assert.strictEqual(streak.currentLevel, 1, "streak level 1");
  console.log("2. GM ok: login +", LOGIN_BONUS, "pts, streak ->", streak.currentLevel);

  // 3. Seed SWIPE_CAP+1 synthetic markets (deterministic; live pool depth is verified
  //    separately by verify:polymarket). One bet per market (C1) needs distinct markets.
  const deadline = new Date(Date.now() + 3_600_000);
  const markets = [];
  for (let i = 0; i < SWIPE_CAP + 1; i++) {
    markets.push(
      await prisma.market.create({
        data: {
          polymarketId: `${TAG}-mkt-${process.pid}-${i}`,
          question: `Synthetic market ${i}?`,
          yesPriceBp: 4000,
          noPriceBp: 6000, // note: yes+no != 10000 on purpose (C2)
          resolutionDeadline: deadline,
          status: "OPEN",
        },
      }),
    );
  }
  console.log("3. seeded", markets.length, "synthetic markets");

  // 4. Swipe: SWIPE_CAP earning + 1 over-cap, each on a distinct market. Lock the BOUGHT
  //    side's price (C2).
  for (let i = 0; i < SWIPE_CAP + 1; i++) {
    const m = markets[i];
    const side = i % 2 ? "NO" : "YES";
    const lockedPriceBp = side === "YES" ? m.yesPriceBp! : m.noPriceBp!;
    const r = await recordSwipe({ userId: user.id, marketId: m.id, side, lockedPriceBp });
    if (i < SWIPE_CAP) assert.strictEqual(r.pointsAwarded, 1, `swipe ${i} earns a point`);
    else assert.strictEqual(r.pointsAwarded, 0, "over-cap swipe earns 0");
  }

  // C1: a second swipe on a market already bet is rejected by the unique constraint.
  let dedupRejected = false;
  try {
    await recordSwipe({ userId: user.id, marketId: markets[0].id, side: "NO", lockedPriceBp: 6000 });
  } catch {
    dedupRejected = true;
  }
  assert.ok(dedupRejected, "C1: re-betting the same market is rejected");

  const pts1 = await effectivePoints(prisma, user.id);
  assert.strictEqual(pts1.breakdown.SWIPE, SWIPE_CAP, "exactly SWIPE_CAP swipe points");
  assert.strictEqual(pts1.breakdown.LOGIN, LOGIN_BONUS, "login points present");
  console.log("4. swipes: cap held at", pts1.breakdown.SWIPE, "+ C1 dedup rejected re-bet ✓");

  // 5. Resolve one market in our favor and settle. Pick the market behind the first YES bet.
  const firstYesBet = await prisma.bet.findFirst({
    where: { userId: user.id, side: "YES" },
    orderBy: { createdAt: "asc" },
  });
  assert.ok(firstYesBet, "have a YES bet");
  const expected = computePnl({
    side: "YES",
    stakeCents: firstYesBet!.stakeCents,
    lockedPriceBp: firstYesBet!.lockedPriceBp,
    resolvedYes: true,
  });
  const bal0 = (await prisma.virtualBalance.findUnique({ where: { userId: user.id } }))!.balanceCents;

  const s1 = await settleMarket(prisma, firstYesBet!.marketId, { kind: "resolved", resolvedYes: true });
  console.log("5. settled market:", s1);
  assert.ok(s1.settled >= 1, "settled at least the YES bet");

  const bal1 = (await prisma.virtualBalance.findUnique({ where: { userId: user.id } }))!.balanceCents;
  const settledBet = (await prisma.bet.findUnique({ where: { id: firstYesBet!.id } }))!;
  assert.strictEqual(settledBet.result, "WIN", "YES bet on YES = win");
  assert.strictEqual(settledBet.pnlCents, expected.pnlCents, "balance pnl matches formula");
  assert.strictEqual(bal1 - bal0, s1.settled === 1 ? expected.pnlCents : bal1 - bal0, "balance moved");
  const coll = (await prisma.collectibleBalance.findUnique({ where: { userId: user.id } }))!;
  assert.ok(coll.shards >= 1 || coll.artifacts >= 1, "win awarded a shard");
  console.log("   balance", bal0, "->", bal1, "(pnl", settledBet.pnlCents + ")", "shards", coll.shards);

  // 6. IDEMPOTENCY: re-settle the same market = no-op (no double pnl, no double shard).
  const s2 = await settleMarket(prisma, firstYesBet!.marketId, { kind: "resolved", resolvedYes: true });
  const bal2 = (await prisma.virtualBalance.findUnique({ where: { userId: user.id } }))!.balanceCents;
  const coll2 = (await prisma.collectibleBalance.findUnique({ where: { userId: user.id } }))!;
  assert.strictEqual(s2.settled, 0, "re-settle settles nothing");
  assert.strictEqual(bal2, bal1, "re-settle does not move balance");
  assert.strictEqual(coll2.shards, coll.shards, "re-settle does not double the shard");
  console.log("6. idempotency: re-settle no-op (balance & shards unchanged) ✓");

  console.log("\nSMOKE: end-to-end daily loop OK");
  await cleanup();
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("SMOKE FAILED:", e);
  await cleanup().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
