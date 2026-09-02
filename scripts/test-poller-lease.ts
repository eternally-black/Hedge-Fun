// DB-backed check for the single-runner poller lease (src/lib/poller-lease.ts): one holder
// at a time, renewable by the same holder, and an expired lease is taken over by another.
// Needs DATABASE_URL (Docker DB). Run: npx tsx scripts/test-poller-lease.ts
import assert from "node:assert";
import { prisma } from "../src/lib/prisma";
import { acquirePollerLease } from "../src/lib/poller-lease";

async function main() {
  const holderA = `test-a-${process.pid}`;
  const holderB = `test-b-${process.pid}`;

  try {
    // C1: A acquires a fresh lease.
    assert.strictEqual(await acquirePollerLease(prisma, holderA, 60_000), true, "A acquires");

    // C2: B cannot acquire while A holds it.
    assert.strictEqual(await acquirePollerLease(prisma, holderB, 60_000), false, "B blocked by A");

    // C3: A renews (same holder matches the WHERE).
    assert.strictEqual(await acquirePollerLease(prisma, holderA, 60_000), true, "A renews");

    // C4: force expiry, then B acquires.
    await prisma.pollerLease.update({ where: { id: 1 }, data: { expiresAt: new Date(Date.now() - 1) } });
    assert.strictEqual(await acquirePollerLease(prisma, holderB, 60_000), true, "B takes over after expiry");

    console.log("OK: poller lease — one holder at a time, renewable, expires on its own");
  } finally {
    await prisma.pollerLease.deleteMany();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAIL:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
