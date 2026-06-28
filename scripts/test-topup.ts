// Top-up paths: free (once, low-cash gate), artifact (spend 1, no gate, race-safe).
// DB-backed. Run: npx tsx scripts/test-topup.ts  (needs DATABASE_URL)
import assert from "node:assert";
import { prisma } from "../src/lib/prisma";
import { topUp } from "../src/lib/topup";
import { TOPUP_GRANT_CENTS, FREE_TOPUP_CASH_GATE_CENTS } from "../src/lib/config";
import { randomCode } from "../src/lib/refcode";

async function mkUser(tag: string, balanceCents: number, artifacts = 0) {
  return prisma.user.create({
    data: { privyId: `did:privy:${tag}`, authProvider: "EMAIL", referralCode: randomCode(),
      virtualBalance: { create: { balanceCents } },
      collectibleBalance: { create: { artifacts } }, streak: { create: {} } },
  });
}
async function cleanup(userId: string) {
  await prisma.pointsLedger.deleteMany({ where: { userId } });
  await prisma.virtualBalance.deleteMany({ where: { userId } });
  await prisma.collectibleBalance.deleteMany({ where: { userId } });
  await prisma.streak.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
}

async function main() {
  const base = `topuptest-${process.pid}-${Date.now() & 0xffffff}`;

  // (1) FREE: low cash (below gate) → granted once; second call → free_used.
  const lowCash = FREE_TOPUP_CASH_GATE_CENTS - 1; // under $30, no pending bets → eligible
  const u1 = await mkUser(`${base}-free`, lowCash);
  const r1 = await topUp(u1.id, "free");
  assert.ok(r1.ok && r1.kind === "free", "free top-up granted at low cash");
  assert.strictEqual((await prisma.virtualBalance.findUniqueOrThrow({ where: { userId: u1.id } })).balanceCents, lowCash + TOPUP_GRANT_CENTS, "free grant added to balance");
  const r1b = await topUp(u1.id, "free");
  assert.ok(!r1b.ok && r1b.reason === "free_used", "free top-up only once ever");
  await cleanup(u1.id);

  // (2) FREE GATE: cash above the gate → free_not_eligible, no grant.
  const u2 = await mkUser(`${base}-gate`, FREE_TOPUP_CASH_GATE_CENTS + 10000);
  const r2 = await topUp(u2.id, "free");
  assert.ok(!r2.ok && r2.reason === "free_not_eligible", "free blocked when cash above gate");
  await cleanup(u2.id);

  // (3) ARTIFACT: spend 1 artifact, no cash gate (user has plenty of cash). Decrements + grants.
  const u3 = await mkUser(`${base}-art`, 100000, 2);
  const r3 = await topUp(u3.id, "artifact");
  assert.ok(r3.ok && r3.kind === "artifact", "artifact top-up granted with cash present (no gate)");
  const cb3 = await prisma.collectibleBalance.findUniqueOrThrow({ where: { userId: u3.id } });
  assert.strictEqual(cb3.artifacts, 1, "one artifact spent");
  const vb3 = await prisma.virtualBalance.findUniqueOrThrow({ where: { userId: u3.id } });
  assert.strictEqual(vb3.balanceCents, 100000 + TOPUP_GRANT_CENTS, "artifact grant added to balance");
  assert.strictEqual(vb3.topupCount, 1, "topupCount incremented");
  await cleanup(u3.id);

  // (4) ARTIFACT RACE: exactly 1 artifact → two concurrent top-ups, only ONE succeeds.
  const u4 = await mkUser(`${base}-race`, 100000, 1);
  const race = await Promise.allSettled([topUp(u4.id, "artifact"), topUp(u4.id, "artifact")]);
  const granted = race.filter((r) => r.status === "fulfilled" && (r.value as { ok: boolean }).ok).length;
  assert.strictEqual(granted, 1, `exactly one artifact top-up wins the race (got ${granted})`);
  const cb4 = await prisma.collectibleBalance.findUniqueOrThrow({ where: { userId: u4.id } });
  assert.strictEqual(cb4.artifacts, 0, "artifact not double-spent");
  const vb4 = await prisma.virtualBalance.findUniqueOrThrow({ where: { userId: u4.id } });
  assert.strictEqual(vb4.balanceCents, 100000 + TOPUP_GRANT_CENTS, "balance credited once, not twice");
  await cleanup(u4.id);

  // (5) ARTIFACT with none → no_artifact.
  const u5 = await mkUser(`${base}-noart`, 100000, 0);
  const r5 = await topUp(u5.id, "artifact");
  assert.ok(!r5.ok && r5.reason === "no_artifact", "no artifact → rejected");
  await cleanup(u5.id);

  console.log("OK: free once+gated, artifact spend race-safe");
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); }).finally(() => prisma.$disconnect());
