// Card-skins economy: unlock spends artifacts (race-safe) + equips; equip needs ownership; bad ids
// rejected. DB-backed. Run: npx tsx scripts/test-skins-db.ts  (needs DATABASE_URL)
import assert from "node:assert";
import { prisma } from "../src/lib/prisma";
import { runSkinAction } from "../src/lib/skins-store";
import { skinById } from "../src/lib/skins";
import { randomCode } from "../src/lib/refcode";

const AURORA = skinById("aurora")!; // cost 5
const VAPOR = skinById("vapor")!; // cost 2

async function mkUser(tag: string, artifacts = 0) {
  return prisma.user.create({
    data: {
      privyId: `did:privy:${tag}`,
      authProvider: "EMAIL",
      referralCode: randomCode(),
      collectibleBalance: { create: { artifacts } },
    },
  });
}
async function cleanup(userId: string) {
  await prisma.collectibleBalance.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
}

async function main() {
  const base = `skinstest-${process.pid}-${Date.now() & 0xffffff}`;

  // (1) Fresh balance row defaults to owning + equipping Classic.
  const u0 = await mkUser(`${base}-default`, 0);
  const cb0 = await prisma.collectibleBalance.findUniqueOrThrow({ where: { userId: u0.id } });
  assert.deepStrictEqual(cb0.ownedSkins, ["classic"], "fresh user owns classic");
  assert.strictEqual(cb0.equippedSkin, "classic", "fresh user equips classic");
  await cleanup(u0.id);

  // (2) UNLOCK: enough artifacts → spends cost, adds to owned, equips instantly.
  const u1 = await mkUser(`${base}-unlock`, 7);
  const r1 = await runSkinAction(u1.id, "unlock", "aurora");
  assert.ok(r1.ok, "unlock succeeds with enough artifacts");
  assert.strictEqual(r1.ok && r1.artifacts, 7 - AURORA.cost, "artifacts decremented by cost");
  assert.ok(r1.ok && r1.owned.includes("aurora"), "aurora added to owned");
  assert.strictEqual(r1.ok && r1.equipped, "aurora", "unlock auto-equips");
  // re-unlock the same skin → already_owned, no further spend.
  const r1b = await runSkinAction(u1.id, "unlock", "aurora");
  assert.ok(!r1b.ok && r1b.reason === "already_owned", "can't re-buy an owned skin");
  assert.strictEqual((await prisma.collectibleBalance.findUniqueOrThrow({ where: { userId: u1.id } })).artifacts, 2, "no double-spend on re-unlock");
  await cleanup(u1.id);

  // (3) UNLOCK with too few artifacts → no_artifact, nothing spent.
  const u2 = await mkUser(`${base}-broke`, 1);
  const r2 = await runSkinAction(u2.id, "unlock", "aurora"); // cost 5 > 1
  assert.ok(!r2.ok && r2.reason === "no_artifact", "broke unlock rejected");
  const cb2 = await prisma.collectibleBalance.findUniqueOrThrow({ where: { userId: u2.id } });
  assert.strictEqual(cb2.artifacts, 1, "no artifacts spent on a rejected unlock");
  assert.deepStrictEqual(cb2.ownedSkins, ["classic"], "owned unchanged on rejected unlock");
  await cleanup(u2.id);

  // (4) EQUIP: an owned skin switches; an un-owned one is rejected; switching back to classic works.
  const u3 = await mkUser(`${base}-equip`, 2);
  await runSkinAction(u3.id, "unlock", "vapor"); // now owns classic+vapor, equipped vapor
  const eq = await runSkinAction(u3.id, "equip", "classic");
  assert.ok(eq.ok && eq.equipped === "classic", "equip an owned skin switches");
  const eqBad = await runSkinAction(u3.id, "equip", "midas"); // not owned
  assert.ok(!eqBad.ok && eqBad.reason === "not_owned", "can't equip an un-owned skin");
  assert.strictEqual((await prisma.collectibleBalance.findUniqueOrThrow({ where: { userId: u3.id } })).artifacts, 2 - VAPOR.cost, "equip costs nothing");
  await cleanup(u3.id);

  // (5) UNKNOWN id → unknown_skin (route would 400).
  const u4 = await mkUser(`${base}-bad`, 9);
  const r4 = await runSkinAction(u4.id, "unlock", "not-a-skin");
  assert.ok(!r4.ok && r4.reason === "unknown_skin", "unknown skin id rejected");
  await cleanup(u4.id);

  // (6) RACE: two concurrent unlocks of the SAME skin with exactly its cost → only ONE wins, the
  // artifact is spent once (no double-spend), and the skin is added to owned exactly once.
  const u5 = await mkUser(`${base}-race`, AURORA.cost); // exactly aurora's cost
  const race = await Promise.allSettled([
    runSkinAction(u5.id, "unlock", "aurora"),
    runSkinAction(u5.id, "unlock", "aurora"),
  ]);
  const wins = race.filter((r) => r.status === "fulfilled" && (r.value as { ok: boolean }).ok).length;
  assert.strictEqual(wins, 1, `exactly one unlock wins the race (got ${wins})`);
  const cb5 = await prisma.collectibleBalance.findUniqueOrThrow({ where: { userId: u5.id } });
  assert.strictEqual(cb5.artifacts, 0, "artifact spent once, not double");
  assert.strictEqual(cb5.ownedSkins.filter((s) => s === "aurora").length, 1, "aurora added exactly once");
  await cleanup(u5.id);

  console.log("OK: skins unlock spends+equips, ownership-gated equip, bad ids + races safe");
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); }).finally(() => prisma.$disconnect());
