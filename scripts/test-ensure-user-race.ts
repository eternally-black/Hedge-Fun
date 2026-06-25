// Verifies the first-login race fix in ensureUser: two parallel creates of the same
// privyId must NOT both fail — the loser hits P2002 and reads the winner back.
// This asserts the exact error shape the fix branches on (Prisma P2002), against the
// live DB. Run: npx tsx scripts/test-ensure-user-race.ts  (needs DATABASE_URL)
import assert from "node:assert";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { randomCode } from "../src/lib/refcode";

async function main() {
  const privyId = `did:privy:racetest-${process.pid}-${Date.now() & 0xffffff}`;

  // Fire two creates concurrently for the same unique privyId — the real race.
  // Minimal row (no nested relations): we're asserting the privyId unique-violation
  // shape the fix catches, not the full provisioning graph.
  const mk = () => prisma.user.create({ data: { privyId, authProvider: "EMAIL", referralCode: randomCode() } });

  const results = await Promise.allSettled([mk(), mk()]);
  const ok = results.filter((r) => r.status === "fulfilled");
  const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];

  assert.strictEqual(ok.length, 1, "exactly one create must win");
  assert.strictEqual(failed.length, 1, "exactly one create must lose");

  // The loser's error MUST be the P2002 shape the fix catches — else the fix's branch
  // would never trigger and first-login would 401 again.
  const err = failed[0].reason;
  assert.ok(err instanceof Prisma.PrismaClientKnownRequestError, "loser error is a Prisma known error");
  assert.strictEqual(err.code, "P2002", "loser error code is P2002 (unique violation)");

  // And the winner's row is readable back (what ensureUser's catch does).
  const readBack = await prisma.user.findUnique({ where: { privyId } });
  assert.ok(readBack, "winner row is readable after the race");

  // cleanup
  await prisma.user.delete({ where: { privyId } });

  console.log("OK: first-login race resolves to one user via P2002 read-back");
}

main()
  .catch((e) => { console.error("FAIL:", e); process.exit(1); })
  .finally(() => prisma.$disconnect());
