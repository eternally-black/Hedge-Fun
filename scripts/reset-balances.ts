// ONE-OFF migration to the Cash/Locked economy ($200 start, $10 stake). Run once after
// `npm run db:push`, before deploy:  npx tsx scripts/reset-balances.ts
//
// Why: legacy bets were placed under the old "no debit" model at the old $100 stake. If we just
// reset balances and leave them PENDING, Locked (= Σ pending stakes at $100) can exceed the new
// $200 balance → negative Cash. So we VOID every PENDING bet first (they were never actually paid
// for — nothing to refund/settle), which makes Locked = 0, then hard-reset everyone to $200.
//   - VOID (not delete): preserves history + ShardGrant FK integrity.
//   - seenAt = now: suppresses a wall of "void" reveals on each user's next app open.
import { prisma } from "../src/lib/prisma";
import { START_BALANCE_CENTS } from "../src/lib/config";

(async () => {
  const now = new Date();

  // 1. Void all still-open bets so no stake stays locked across the reset.
  const voided = await prisma.bet.updateMany({
    where: { settlementStatus: "PENDING" },
    data: {
      settlementStatus: "VOID",
      result: "PUSH",
      payoutCents: 0,
      pnlCents: 0,
      settledAt: now,
      seenAt: now,
    },
  });

  // 2. Hard-reset every balance to $200, zero the hold (all pending now voided), clear top-up state.
  const reset = await prisma.virtualBalance.updateMany({
    data: { balanceCents: START_BALANCE_CENTS, lockedCents: 0, freeTopupUsed: false, topupCount: 0 },
  });

  console.log(`voided ${voided.count} pending bets; reset ${reset.count} balances to ${START_BALANCE_CENTS}c`);
  await prisma.$disconnect();
})();
