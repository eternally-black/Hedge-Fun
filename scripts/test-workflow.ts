// scripts/test-workflow.ts — the durable signature-relay engine (plan §2.4) against fake
// generators: park/replay/byte-match, crash fence, single-flight reuse, non-determinism guards,
// plus the encrypted CLOB-creds roundtrip. Run: npx tsx scripts/test-workflow.ts
import assert from "node:assert";
import { prisma } from "../src/lib/prisma";
import { driveWorkflow, completeWorkflow, type WorkflowGen } from "../src/lib/workflow";
import { saveClobCreds, loadClobCreds } from "../src/lib/clob-creds";
import { randomCode } from "../src/lib/refcode";

const makeFactory =
  (marker: string, log?: string[]) =>
  (): WorkflowGen =>
    (async function* (): AsyncGenerator<{ kind: string; payload?: unknown }, { transactionId: string }, string> {
      log?.push("built");
      const a1 = yield { kind: "requestAddress" };
      const a2 = yield { kind: "signGaslessTypedData", payload: { m: marker, step: 1 } };
      const a3 = yield { kind: "signGaslessMessage", payload: { m: marker, step: 2 } };
      void a1;
      void a2;
      void a3;
      return { transactionId: `tx-${marker}` };
    })() as unknown as WorkflowGen;

const autoAnswer = (r: { kind: string; payload?: unknown }) => (r.kind === "requestAddress" ? "0xsigner" : null);

async function main() {
  const tag = `wf-${process.pid}-${Date.now() & 0xffffff}`;
  const user = await prisma.user.create({
    data: {
      privyId: `did:privy:${tag}`,
      authProvider: "EMAIL",
      referralCode: randomCode(),
    },
  });

  try {
    const inputsA = { amount: "1000000", token: "USDC.e" };
    const drive = (over: Partial<Parameters<typeof driveWorkflow>[1]> = {}) =>
      driveWorkflow(prisma, {
        userId: user.id,
        kind: "WRAP",
        inputs: inputsA,
        factory: makeFactory("a"),
        autoAnswer,
        ...over,
      });

    // 1. Start: requestAddress auto-answered+stored, parks on the typed-data request (step 1).
    const buildLog: string[] = [];
    const r1 = await drive({ factory: makeFactory("a", buildLog) });
    assert.strictEqual(r1.status, "pending_signature");
    if (r1.status !== "pending_signature") throw new Error("unreachable");
    assert.strictEqual(r1.stepIndex, 1);
    const H1 = r1.requestHash;
    assert.strictEqual(H1.length, 64, "sha256 hex");
    let row = await prisma.walletWorkflow.findUniqueOrThrow({ where: { userId_kind: { userId: user.id, kind: "WRAP" } } });
    assert.strictEqual(row.state, "PENDING_SIGNATURE");
    assert.strictEqual(row.stepIndex, 1);

    // 2. Same call again: SAME hash re-served, no drift.
    const r2 = await drive();
    assert.strictEqual(r2.status, "pending_signature");
    if (r2.status !== "pending_signature") throw new Error("unreachable");
    assert.strictEqual(r2.requestHash, H1);

    // 3. Wrong-hash answer is ignored — parks again on H1, state intact.
    const r3 = await drive({ answer: { requestHash: "0".repeat(64), signature: "wrong" } });
    assert.strictEqual(r3.status, "pending_signature");
    if (r3.status !== "pending_signature") throw new Error("unreachable");
    assert.strictEqual(r3.requestHash, H1);

    // 4. Correct answer advances to the second request.
    const r4 = await drive({ answer: { requestHash: H1, signature: "sig1" } });
    assert.strictEqual(r4.status, "pending_signature");
    if (r4.status !== "pending_signature") throw new Error("unreachable");
    assert.strictEqual(r4.stepIndex, 2);
    const H2 = r4.requestHash;
    assert.notStrictEqual(H2, H1);

    // 5. Final answer: crash fence + relayer intent land, generator returns → SUBMITTING.
    const r5 = await drive({ answer: { requestHash: H2, signature: "sig2" } });
    assert.strictEqual(r5.status, "submitting");
    if (r5.status !== "submitting") throw new Error("unreachable");
    assert.strictEqual(r5.transactionId, "tx-a");
    row = await prisma.walletWorkflow.findUniqueOrThrow({ where: { userId_kind: { userId: user.id, kind: "WRAP" } } });
    assert.strictEqual(row.state, "SUBMITTING");
    const relayer = await prisma.relayerTx.findUniqueOrThrow({
      where: { userId_kind_workflowKey: { userId: user.id, kind: "WRAP", workflowKey: row.id } },
    });
    assert.strictEqual(relayer.status, "SUBMITTING");
    assert.ok(relayer.attempts >= 1);

    // 6. SUBMITTING is never re-driven.
    const before6 = buildLog.length;
    const r6 = await drive({ factory: makeFactory("a", buildLog) });
    assert.strictEqual(r6.status, "submitting");
    assert.strictEqual(buildLog.length, before6, "no rebuild while SUBMITTING");

    // 7. Chain-state convergence closes the run.
    await completeWorkflow(prisma, user.id, "WRAP", { ok: true, txHash: "0xabc" });
    row = await prisma.walletWorkflow.findUniqueOrThrow({ where: { userId_kind: { userId: user.id, kind: "WRAP" } } });
    assert.strictEqual(row.state, "DONE");
    assert.strictEqual(row.txHash, "0xabc");
    const relayer7 = await prisma.relayerTx.findUniqueOrThrow({
      where: { userId_kind_workflowKey: { userId: user.id, kind: "WRAP", workflowKey: row.id } },
    });
    assert.strictEqual(relayer7.status, "CONFIRMED");

    // 8. Same inputs on a DONE row: idempotent done, no rebuild.
    const before8 = buildLog.length;
    const r8 = await drive({ factory: makeFactory("a", buildLog) });
    assert.strictEqual(r8.status, "done");
    assert.strictEqual(buildLog.length, before8);

    // 9. NEW inputs reset the single-flight slot (one wrap per deposit).
    const r9 = await drive({ inputs: { amount: "2000000", token: "USDC.e" }, factory: makeFactory("b") });
    assert.strictEqual(r9.status, "pending_signature");
    if (r9.status !== "pending_signature") throw new Error("unreachable");
    assert.strictEqual(r9.stepIndex, 1);

    // 10. Non-determinism guard: a rebuild whose PENDING request changed fails closed.
    const r10a = await driveWorkflow(prisma, {
      userId: user.id,
      kind: "APPROVALS",
      inputs: { token: "USDC.e" },
      factory: makeFactory("x"),
      autoAnswer,
    });
    assert.strictEqual(r10a.status, "pending_signature");
    if (r10a.status !== "pending_signature") throw new Error("unreachable");
    const r10b = await driveWorkflow(prisma, {
      userId: user.id,
      kind: "APPROVALS",
      inputs: { token: "USDC.e" },
      factory: makeFactory("y"), // different payloads on rebuild
      autoAnswer,
      answer: { requestHash: r10a.requestHash, signature: "sig10" },
    });
    assert.strictEqual(r10b.status, "failed");
    if (r10b.status !== "failed") throw new Error("unreachable");
    assert.ok(r10b.error.includes("non-deterministic"), `unexpected error: ${r10b.error}`);
    const row10 = await prisma.walletWorkflow.findUniqueOrThrow({
      where: { userId_kind: { userId: user.id, kind: "APPROVALS" } },
    });
    assert.strictEqual(row10.state, "FAILED");

    // 11. Encrypted CLOB-creds roundtrip.
    const originalKey = process.env.REAL_CREDS_KEY;
    process.env.REAL_CREDS_KEY = "ab".repeat(32);
    const creds = { key: "k1", secret: "s1", passphrase: "p1" };
    assert.strictEqual(await saveClobCreds(prisma, user.id, creds), true);
    assert.deepStrictEqual(await loadClobCreds(prisma, user.id), creds);
    process.env.REAL_CREDS_KEY = "cd".repeat(32);
    assert.strictEqual(await loadClobCreds(prisma, user.id), null, "wrong key -> null, not throw");
    process.env.REAL_CREDS_KEY = "";
    assert.strictEqual(await saveClobCreds(prisma, user.id, creds), false, "no key -> presence-gated false");
    if (originalKey !== undefined) process.env.REAL_CREDS_KEY = originalKey;

    console.log("OK: workflow engine — park/replay/byte-match, fence, single-flight, non-determinism, creds");
    console.log("PASS: workflow");
  } finally {
    await prisma.relayerTx.deleteMany({ where: { userId: user.id } });
    await prisma.walletWorkflow.deleteMany({ where: { userId: user.id } });
    await prisma.clobCredential.deleteMany({ where: { userId: user.id } });
    await prisma.user.deleteMany({ where: { id: user.id } });
  }
}

main()
  .catch((e) => {
    console.error("FAIL:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
