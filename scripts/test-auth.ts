// (5) authUser is the single auth gate for EVERY route and BOTH clients (web + Android). A wrong
// token must yield null (-> 401); a valid one must resolve to the RIGHT app user, provisioning on
// first sight. The only network seam is PrivyClient.verifyAuthToken — we stub it at the prototype
// level (the one Privy call) and let everything else (bearer parsing, ensureUser, the DB) run real.
// Run: npx tsx scripts/test-auth.ts  (needs DATABASE_URL)
import assert from "node:assert";
import { PrivyClient } from "@privy-io/server-auth";

// Stub the ONE network call BEFORE importing privy.ts (the module instantiates a PrivyClient at
// import time). verifyAuthToken: a token of "good:<did>" verifies to that did; anything else throws
// like an invalid/expired token would. getUser supplies the identity ensureUser reads on first login.
const STUB_DID = `did:privy:authtest-${process.pid}-${Date.now() & 0xffffff}`;
(PrivyClient.prototype as any).verifyAuthToken = async (token: string) => {
  if (typeof token === "string" && token.startsWith("good:")) return { userId: token.slice(5) };
  throw new Error("invalid auth token"); // matches /token|jwt|auth/i so authUser stays quiet
};
(PrivyClient.prototype as any).getUser = async (_did: string) => ({
  email: { address: `${STUB_DID}@test.local` },
  twitter: null,
  wallet: null,
  linkedAccounts: [],
});

const mkReq = (auth?: string) =>
  new Request("http://x/api/me", auth ? { headers: { authorization: auth } } : undefined);

async function main() {
  const { authUser, verifyPrivyToken, bearer } = await import("../src/lib/privy");
  const { prisma } = await import("../src/lib/prisma");

  // bearer() extracts only a well-formed "Bearer <token>" header.
  assert.strictEqual(bearer(mkReq("Bearer xyz")), "xyz", "bearer extracts the token");
  assert.strictEqual(bearer(mkReq("xyz")), null, "non-Bearer header -> null");
  assert.strictEqual(bearer(mkReq()), null, "missing header -> null");

  // verifyPrivyToken: valid -> DID; invalid -> throws.
  assert.strictEqual(await verifyPrivyToken(`good:${STUB_DID}`), STUB_DID, "valid token -> DID");
  await assert.rejects(() => verifyPrivyToken("bad-token"), /token/i, "invalid token throws");

  // authUser, no token -> null (the 401 path).
  assert.strictEqual(await authUser(mkReq()), null, "no Authorization header -> null");
  // authUser, invalid token -> null (expired/garbage -> 401).
  assert.strictEqual(await authUser(mkReq("Bearer not-good")), null, "invalid token -> null");

  // authUser, valid token -> provisions + returns the RIGHT user (first login).
  const u1 = await authUser(mkReq(`Bearer good:${STUB_DID}`));
  assert.ok(u1, "valid token resolves a user");
  assert.strictEqual(u1!.privyId, STUB_DID, "resolved user matches the token's DID");
  assert.strictEqual(u1!.email, `${STUB_DID}@test.local`, "identity provisioned from Privy getUser");

  // Second call with the same token returns the SAME user (no duplicate provisioning).
  const u2 = await authUser(mkReq(`Bearer good:${STUB_DID}`));
  assert.strictEqual(u2!.id, u1!.id, "same token -> same user id (idempotent provisioning)");
  const count = await prisma.user.count({ where: { privyId: STUB_DID } });
  assert.strictEqual(count, 1, "exactly one user row for the DID");

  // cleanup
  await prisma.virtualBalance.deleteMany({ where: { userId: u1!.id } });
  await prisma.collectibleBalance.deleteMany({ where: { userId: u1!.id } });
  await prisma.streak.deleteMany({ where: { userId: u1!.id } });
  await prisma.dailyCounter.deleteMany({ where: { userId: u1!.id } });
  await prisma.pointsLedger.deleteMany({ where: { userId: u1!.id } });
  await prisma.user.delete({ where: { id: u1!.id } });
  await prisma.$disconnect();

  console.log("OK: authUser gates every route — no/invalid token -> null, valid -> right user (idempotent)");
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
