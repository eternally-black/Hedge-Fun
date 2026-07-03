// Narrow check of the NEW /api/me Cash/Locked/topup contract shape (cheaper than the full
// test-api-contract harness — one user, one /me call — so it catches a connection window on the
// flaky WSL NAT). Run: npx tsx scripts/test-me-shape.ts
import assert from "node:assert";
import { PrivyClient } from "@privy-io/server-auth";

const STUB_DID = `did:privy:meshape-${process.pid}-${Date.now() & 0xffffff}`;
(PrivyClient.prototype as any).verifyAuthToken = async (t: string) => {
  if (t === "good") return { userId: STUB_DID };
  throw new Error("bad token");
};
(PrivyClient.prototype as any).getUser = async () => ({
  email: { address: `${STUB_DID}@test.local` }, twitter: null, wallet: null, linkedAccounts: [],
});

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const me = await import("../src/app/api/me/route");
  const authed = (url: string) => new Request(url, { headers: { authorization: "Bearer good" } });

  const body = await (await me.GET(authed("http://x/api/me"))).json();

  // Top-level key set must include the new Cash/Locked/topup fields + cosmetics (skins).
  assert.deepStrictEqual(Object.keys(body).sort(),
    ["artifacts","balanceCents","cashCents","dev","isNewUser","lockedCents","loginMarkedToday","points","referrals","shards","shardsPerArtifact","skins","skips","stakeCents","streak","swipes","topup","unreadResults","user"],
    "/me top-level keys include cashCents/lockedCents/stakeCents/topup/skins");
  assert.deepStrictEqual(Object.keys(body.topup).sort(),
    ["artifactCashGateCents","artifactCost","artifactTopupAvailable","freeTopupAvailable","freeTopupUsed","grantCents"],
    "/me topup sub-keys");

  // Fresh user: $200 balance, no holds → Cash $200, Locked 0, stake $10.
  assert.strictEqual(body.balanceCents, 20000, "fresh balance $200");
  assert.strictEqual(body.lockedCents, 0, "no holds yet");
  assert.strictEqual(body.cashCents, 20000, "cash == balance when nothing locked");
  assert.strictEqual(body.stakeCents, 1000, "stake $10");
  assert.strictEqual(body.topup.grantCents, 20000, "top-up grant $200");
  assert.strictEqual(body.topup.freeTopupUsed, false, "free top-up not used on a fresh account");
  assert.strictEqual(typeof body.topup.freeTopupAvailable, "boolean", "freeTopupAvailable is bool");

  // Cosmetics: a fresh account owns + equips the free Classic skin.
  assert.deepStrictEqual(body.skins.owned, ["classic"], "fresh account owns classic");
  assert.strictEqual(body.skins.equipped, "classic", "fresh account equips classic");

  // cleanup
  const u = await prisma.user.findUniqueOrThrow({ where: { privyId: STUB_DID } });
  await prisma.pointsLedger.deleteMany({ where: { userId: u.id } });
  await prisma.dailyCounter.deleteMany({ where: { userId: u.id } });
  await prisma.virtualBalance.deleteMany({ where: { userId: u.id } });
  await prisma.collectibleBalance.deleteMany({ where: { userId: u.id } });
  await prisma.streak.deleteMany({ where: { userId: u.id } });
  await prisma.user.delete({ where: { id: u.id } });

  console.log("OK: /me Cash/Locked/topup contract shape + fresh-account values");
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); }).finally(async () => {
  const { prisma } = await import("../src/lib/prisma");
  await prisma.$disconnect();
});
