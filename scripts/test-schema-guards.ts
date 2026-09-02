// DB-backed guard for the hand-written partial unique indexes and CHECK constraints that
// Prisma cannot model. They live only in migration SQL, so a schema-diffed migration can
// silently DROP them — this test fails the suite the moment one is gone.
// Needs DATABASE_URL (Docker DB). Run: npx tsx scripts/test-schema-guards.ts
import assert from "node:assert";
import { prisma } from "../src/lib/prisma";

async function main() {
  const indexNames = ["order_attempts_one_inflight", "funding_attempts_one_active"];
  const checkNames = [
    "bets_closed_le_filled",
    "bets_paper_no_real_fields",
    "bets_real_fields_nonneg",
    "fills_sane",
  ];

  const indexes = await prisma.$queryRaw<{ indexname: string }[]>`
    SELECT indexname FROM pg_indexes WHERE indexname = ANY(${indexNames})
  `;
  const foundIndexes = new Set(indexes.map((r) => r.indexname));
  for (const name of indexNames) {
    assert.ok(foundIndexes.has(name), `partial unique index ${name} is missing`);
  }

  const constraints = await prisma.$queryRaw<{ conname: string }[]>`
    SELECT conname FROM pg_constraint WHERE conname = ANY(${checkNames})
  `;
  const foundConstraints = new Set(constraints.map((r) => r.conname));
  for (const name of checkNames) {
    assert.ok(foundConstraints.has(name), `CHECK constraint ${name} is missing`);
  }

  console.log("OK: schema guards — partial uniques and CHECK constraints are all present");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAIL:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
