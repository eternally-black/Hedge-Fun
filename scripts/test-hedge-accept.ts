// DB-backed end-to-end check for the S1 hedge accept flow (swipe-cap test style). Seeds a wallet
// snapshot + a parsed SOL market, derives a deterministic suggestion, accepts it, and asserts:
//   - a source=HEDGE Bet with the SIZED variable stake is created and the stake is HELD vs Cash
//   - accept is IDEMPOTENT (re-accept returns the same bet, no double-hold)
//   - the stake CLAMPS DOWN to available Cash; below the floor -> InsufficientFundsError
//   - the hedge bet rides the EXISTING settlement poller unchanged (settleMarket settles it)
//   - impression/dismiss telemetry is idempotent
// Needs DATABASE_URL (Docker DB). Run: npx tsx scripts/test-hedge-accept.ts
import assert from "node:assert";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { randomCode } from "../src/lib/refcode";
import { deriveForUser } from "../src/lib/hedge/suggest";
import { acceptSuggestion } from "../src/lib/hedge/accept";
import { InsufficientFundsError } from "../src/lib/swipe";
import { recordSuggestionEvent } from "../src/lib/hedge/telemetry";
import { sizeS1 } from "../src/lib/hedge/size";
import { settleMarket } from "./settle";
import type { ExposureResult } from "../src/lib/hedge/exposure";

const SOL_NOTIONAL_CENTS = 100_000; // $1000 SOL holding -> sizeS1 major = a clean, known stake

// A cached snapshot with a single SOL major of the given notional (avgCost omitted -> no narrative).
function solSnapshotExposure(notionalCents: number): ExposureResult {
  return {
    assets: [],
    majors: [{ asset: "SOL", mint: null, amount: notionalCents / 7500, priceCents: 7500, notionalCents, isMajor: true }],
    splAggregateCents: 0,
    totalNotionalCents: notionalCents,
  };
}

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

async function linkSnapshot(userId: string, address: string, notionalCents: number) {
  await prisma.hedgeWallet.create({ data: { userId, address } });
  await prisma.walletSnapshot.upsert({
    where: { address },
    create: {
      address,
      exposure: solSnapshotExposure(notionalCents) as unknown as Prisma.InputJsonValue,
      totalNotionalCents: notionalCents,
      fetchedAt: new Date(),
    },
    update: {
      exposure: solSnapshotExposure(notionalCents) as unknown as Prisma.InputJsonValue,
      totalNotionalCents: notionalCents,
      fetchedAt: new Date(),
    },
  });
}

async function main() {
  const tag = `hedgeacc-${process.pid}-${Date.now() & 0xffffff}`;

  // A parsed SOL "above" market (UP): hedging a long -> NO side. OPEN, priced, resolves in 2h.
  const market = await prisma.market.create({
    data: {
      polymarketId: `${tag}-sol-above`,
      question: "Solana above 200 on some future date?",
      outcomeYesLabel: "Yes",
      outcomeNoLabel: "No",
      yesPriceBp: 4000,
      noPriceBp: 6000,
      status: "OPEN",
      resolutionDeadline: new Date(Date.now() + 2 * 3_600_000),
    },
  });
  await prisma.marketMeta.create({
    data: {
      marketId: market.id,
      asset: "SOL",
      tagSlug: "solana",
      strikeCents: 20_000,
      direction: "UP",
      parsedDeadline: market.resolutionDeadline,
      liquidityCents: 500_000,
      parseOk: true,
    },
  });

  // ── User A: full Cash. Derive -> accept -> assert a HEDGE bet with the sized stake, held. ─────────
  const userA = await makeUser(`${tag}-a`, 20_000);
  const addrA = `${tag}-addrA`;
  await linkSnapshot(userA.id, addrA, SOL_NOTIONAL_CENTS);

  const { items, walletLinked } = await deriveForUser(userA.id, { cacheOnly: true });
  assert.strictEqual(walletLinked, true, "wallet linked");
  const sug = items.find((i) => i.suggestion.hedgedAsset === "SOL" && i.suggestion.kind === "S1-major")?.suggestion;
  assert.ok(sug, "a SOL major suggestion was derived");
  const expectedStake = sizeS1(SOL_NOTIONAL_CENTS, "S1_MAJOR");
  assert.strictEqual(sug!.proposedStakeCents, expectedStake, "proposed stake = sizeS1(major)");
  assert.strictEqual(sug!.side, "NO", "UP market -> NO side hedges the long");

  const acc = await acceptSuggestion(userA.id, sug!.suggestionId);
  assert.strictEqual(acc.alreadyAccepted, false, "first accept is fresh");
  assert.strictEqual(acc.stakeCents, expectedStake, "accepted at the sized stake (full Cash)");
  const bet = await prisma.bet.findUniqueOrThrow({ where: { id: acc.betId } });
  assert.strictEqual(bet.source, "HEDGE", "bet source = HEDGE");
  assert.strictEqual(bet.side, "NO", "bet side = NO");
  assert.strictEqual(bet.stakeCents, expectedStake, "bet stake = sized");
  assert.strictEqual(bet.lockedPriceBp, 6000, "locked the live NO price");
  assert.strictEqual(bet.hedgeSuggestionId, sug!.suggestionId, "bet back-references the suggestion");
  assert.strictEqual(bet.earnedPoint, false, "hedge bet earns no point");
  let vbA = await prisma.virtualBalance.findUniqueOrThrow({ where: { userId: userA.id } });
  assert.strictEqual(vbA.lockedCents, expectedStake, "stake is HELD (lockedCents)");
  const acceptEvt = await prisma.hedgeSuggestionEvent.findUniqueOrThrow({
    where: { userId_suggestionId_event: { userId: userA.id, suggestionId: sug!.suggestionId, event: "ACCEPT" } },
  });
  assert.strictEqual(acceptEvt.betId, acc.betId, "ACCEPT telemetry records the bet");

  // ── Idempotency: re-accept returns the same bet, no second hold. ─────────────────────────────────
  const acc2 = await acceptSuggestion(userA.id, sug!.suggestionId);
  assert.strictEqual(acc2.alreadyAccepted, true, "re-accept is idempotent");
  assert.strictEqual(acc2.betId, acc.betId, "same bet id");
  assert.strictEqual(await prisma.bet.count({ where: { userId: userA.id } }), 1, "no duplicate bet");
  vbA = await prisma.virtualBalance.findUniqueOrThrow({ where: { userId: userA.id } });
  assert.strictEqual(vbA.lockedCents, expectedStake, "no double hold");

  // ── Telemetry idempotency (impression/dismiss). ──────────────────────────────────────────────────
  assert.strictEqual(await recordSuggestionEvent(userA.id, sug!.suggestionId, "IMPRESSION"), true, "impression recorded");
  assert.strictEqual(await recordSuggestionEvent(userA.id, sug!.suggestionId, "IMPRESSION"), true, "impression idempotent");
  assert.strictEqual(
    await prisma.hedgeSuggestionEvent.count({ where: { userId: userA.id, suggestionId: sug!.suggestionId, event: "IMPRESSION" } }),
    1,
    "one impression row",
  );

  // ── User B: low Cash -> the stake CLAMPS DOWN to available Cash. ─────────────────────────────────
  // (B and C derive against the SAME market, so their sections run BEFORE settlement — a
  // resolved market is correctly excluded from matching, and the S1 suggestion would vanish.)
  const lowCash = 5_000;
  const userB = await makeUser(`${tag}-b`, lowCash);
  const addrB = `${tag}-addrB`;
  await linkSnapshot(userB.id, addrB, SOL_NOTIONAL_CENTS);
  const dB = await deriveForUser(userB.id, { cacheOnly: true });
  const sugB = dB.items.find((i) => i.suggestion.kind === "S1-major")!.suggestion;
  assert.ok(sugB.proposedStakeCents > lowCash, "proposed exceeds Cash (so the clamp is exercised)");
  const accB = await acceptSuggestion(userB.id, sugB.suggestionId);
  assert.strictEqual(accB.stakeCents, lowCash, "stake clamped down to available Cash");
  const betB = await prisma.bet.findUniqueOrThrow({ where: { id: accB.betId } });
  assert.strictEqual(betB.stakeCents, lowCash, "bet stored at the clamped stake");

  // ── User C: Cash below the min stake -> InsufficientFundsError, nothing stored. ──────────────────
  const userC = await makeUser(`${tag}-c`, 50);
  const addrC = `${tag}-addrC`;
  await linkSnapshot(userC.id, addrC, SOL_NOTIONAL_CENTS);
  const dC = await deriveForUser(userC.id, { cacheOnly: true });
  const sugC = dC.items.find((i) => i.suggestion.kind === "S1-major")!.suggestion;
  let threw = false;
  try {
    await acceptSuggestion(userC.id, sugC.suggestionId);
  } catch (e) {
    threw = e instanceof InsufficientFundsError;
  }
  assert.ok(threw, "below-floor Cash -> InsufficientFundsError");
  assert.strictEqual(await prisma.bet.count({ where: { userId: userC.id } }), 0, "nothing stored on insufficient Cash");

  // ── Settlement: the hedge bet rides the EXISTING poller. Resolve NO -> the NO bets WIN. ───────────
  // Runs LAST (after B/C derived): settling flips the market to RESOLVED, which correctly removes
  // it from matching. B's clamped bet settles too — asserted through A only; cleanup covers both.
  await settleMarket(prisma, market.id, { kind: "resolved", resolvedYes: false });
  const settled = await prisma.bet.findUniqueOrThrow({ where: { id: acc.betId } });
  assert.strictEqual(settled.settlementStatus, "SETTLED", "hedge bet settled by the standard path");
  assert.strictEqual(settled.result, "WIN", "NO bet wins when the market resolves NO");
  vbA = await prisma.virtualBalance.findUniqueOrThrow({ where: { userId: userA.id } });
  assert.strictEqual(vbA.lockedCents, 0, "hold released on settlement");
  assert.ok(vbA.balanceCents > 20_000, "winning payout credited");

  // ── cleanup (children before parents) ────────────────────────────────────────────────────────────
  const userIds = [userA.id, userB.id, userC.id];
  await prisma.shardGrant.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.dailyCounter.deleteMany({ where: { userId: { in: userIds } } }); // settle's capped shard path writes these
  await prisma.hedgeSuggestionEvent.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.bet.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.marketMeta.deleteMany({ where: { marketId: market.id } });
  await prisma.market.delete({ where: { id: market.id } });
  await prisma.hedgeWallet.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.walletSnapshot.deleteMany({ where: { address: { in: [addrA, addrB, addrC] } } });
  await prisma.virtualBalance.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.collectibleBalance.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.streak.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });

  console.log("OK: hedge accept — sized+held stake, idempotent, Cash-clamped, settles via the standard poller");
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); }).finally(() => prisma.$disconnect());
