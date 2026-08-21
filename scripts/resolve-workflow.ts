// Operator resolution for a wedged money run. A resetNeedsProof workflow (BRIDGE_OUT) that reaches
// SUBMITTING without a relayer handle holds its slot BY DESIGN — releasing it on a balance guess
// could pay the same withdrawal twice — and the engine's own probes can never clear it (the
// relayer verdict needs the handle that was lost). This script is the missing exit the row's own
// error message promises: a human verifies on chain first (did pUSD leave the deposit wallet
// toward the bridge address in the printed inputs?) and records the verdict.
//
//   npx tsx scripts/resolve-workflow.ts <userId> <KIND> landed|failed [note...]
//
//   landed → DONE (the money verifiably moved; RelayerTx CONFIRMED)
//   failed → FAILED (verifiably never moved; the slot is released, and /api/real/withdraw may
//            reuse the already-minted bridge address for the same destination)
import { PrismaClient, type WalletOpKind } from "@prisma/client";

const prisma = new PrismaClient();

const KINDS = ["APPROVALS", "WRAP", "REDEEM", "WITHDRAW", "BRIDGE_OUT"];

async function main(): Promise<void> {
  const [userId, kindArg, verdict, ...noteParts] = process.argv.slice(2);
  if (!userId || !KINDS.includes(kindArg ?? "") || !["landed", "failed"].includes(verdict ?? "")) {
    console.error("usage: npx tsx scripts/resolve-workflow.ts <userId> <KIND> landed|failed [note...]");
    console.error(`       KIND in ${KINDS.join("|")}`);
    process.exit(2);
  }
  const kind = kindArg as WalletOpKind;
  const row = await prisma.walletWorkflow.findUnique({ where: { userId_kind: { userId, kind } } });
  if (!row) {
    console.error(`no ${kind} workflow row for user ${userId}`);
    process.exit(1);
  }
  console.log(`state=${row.state} runId=${row.runId} txHash=${row.txHash} error=${row.error}`);
  console.log(`inputs=${JSON.stringify(row.inputs)}`);
  if (row.state !== "SUBMITTING") {
    console.error(`row is ${row.state}, not SUBMITTING — nothing to resolve`);
    process.exit(1);
  }
  // "failed" means VERIFIABLY NEVER MOVED — it releases the slot, and /api/real/withdraw may then
  // reuse the already-minted bridge address, so a wrong verdict here pays the same withdrawal twice.
  // A non-null txHash is a relayer handle: the submission was handed off, and only the relayer can
  // say it never left. Refuse unless a human states explicitly that they checked.
  if (verdict === "failed" && row.txHash !== null && !noteParts.includes("--i-verified-no-tx")) {
    console.error(`refusing: this run has a relayer handle (txHash=${row.txHash}).`);
    console.error("Check it with the relayer/explorer. If it verifiably never landed, re-run with");
    console.error("  --i-verified-no-tx  as part of the note.");
    process.exit(1);
  }
  const note = `operator resolved: ${verdict}${noteParts.length ? ` — ${noteParts.join(" ")}` : ""}`;
  // CAS on the exact run observed: if a live advance moves the row meanwhile, the human re-reads.
  const res = await prisma.walletWorkflow.updateMany({
    where: { userId, kind, runId: row.runId, state: "SUBMITTING" },
    data: verdict === "landed" ? { state: "DONE", error: null } : { state: "FAILED", error: note },
  });
  if (res.count === 0) {
    console.error("row moved while resolving — re-read and re-run");
    process.exit(1);
  }
  if (row.runId) {
    await prisma.relayerTx.updateMany({
      where: { userId, kind, workflowKey: row.runId },
      data: { status: verdict === "landed" ? "CONFIRMED" : "FAILED" },
    });
  }
  console.log(`resolved ${kind} for ${userId}: ${verdict === "landed" ? "DONE" : "FAILED"} (${note})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
