// scripts/test-workflow.ts — the live-session signature-relay engine v2 (plan §2.4 rework):
// park/re-serve, lost-session restart, CAS fencing, per-run RelayerTx, convergence-driven DONE,
// expiry reset, plus the encrypted CLOB-creds roundtrip (with AAD). Run: npx tsx scripts/test-workflow.ts
import assert from "node:assert";
import { prisma } from "../src/lib/prisma";
import {
  startWorkflow,
  answerWorkflow,
  runScoped,
  _dropLiveSessions,
  type TxVerdict,
  type WorkflowGen,
  type WorkflowSpec,
} from "../src/lib/workflow";
import { saveClobCreds, loadClobCreds } from "../src/lib/clob-creds";
import { randomCode } from "../src/lib/refcode";

// Deterministic within one live session; markers make cross-run envelopes differ like real
// nonce/deadline drift would.
const makeFactory =
  (marker: string, log?: string[]) =>
  (): WorkflowGen =>
    (async function* (): AsyncGenerator<{ kind: string; payload?: unknown }, { transactionId: string }, string> {
      log?.push(`built-${marker}`);
      yield { kind: "requestAddress" };
      yield { kind: "signGaslessTypedData", payload: { m: marker, step: 1 } };
      yield { kind: "signGaslessMessage", payload: { m: marker, step: 2 } };
      return { transactionId: `tx-${marker}` };
    })() as unknown as WorkflowGen;

async function main() {
  const tag = `wf-${process.pid}-${Date.now() & 0xffffff}`;
  const user = await prisma.user.create({
    data: { privyId: `did:privy:${tag}`, authProvider: "EMAIL", referralCode: randomCode() },
  });
  const verified = { value: false }; // controllable chain-truth stub

  const spec = (marker: string, log?: string[], over: Partial<WorkflowSpec> = {}): WorkflowSpec => ({
    userId: user.id,
    kind: "WRAP",
    inputs: { attemptId: "att-1", amountMicro: "1000000" },
    factory: makeFactory(marker, log),
    autoAnswer: (r) => (r.kind === "requestAddress" ? "0xsigner" : null),
    verify: async () => verified.value,
    definitelyNotDone: async () => !verified.value,
    ...over,
  });

  try {
    // 1. Start: requestAddress auto-answered (fenced advance), parks on the typed-data request.
    const log: string[] = [];
    const r1 = await startWorkflow(prisma, spec("a", log));
    assert.strictEqual(r1.status, "pending_signature");
    if (r1.status !== "pending_signature") throw new Error("unreachable");
    const { runId, requestHash: H1 } = r1;
    assert.ok(runId.length > 10, "runId assigned");
    let row = await prisma.walletWorkflow.findUniqueOrThrow({ where: { userId_kind: { userId: user.id, kind: "WRAP" } } });
    assert.strictEqual(row.state, "PENDING_SIGNATURE");
    assert.strictEqual(row.runId, runId);

    // 2. Start again while live: SAME run and hash re-served, generator NOT rebuilt.
    const r2 = await startWorkflow(prisma, spec("a", log));
    assert.strictEqual(r2.status, "pending_signature");
    if (r2.status !== "pending_signature") throw new Error("unreachable");
    assert.strictEqual(r2.runId, runId);
    assert.strictEqual(r2.requestHash, H1);
    assert.strictEqual(log.length, 1, "no rebuild while the session is live");

    // 3. Wrong-hash / wrong-run answers are stale, state untouched.
    const bad1 = await answerWorkflow(prisma, spec("a", log), { runId, requestHash: "0".repeat(64), signature: "sig" });
    assert.strictEqual(bad1.status, "stale");
    const bad2 = await answerWorkflow(prisma, spec("a", log), { runId: "nope", requestHash: H1, signature: "sig" });
    assert.strictEqual(bad2.status, "stale");

    // 4. Correct answer advances to the second device request (same run).
    const r4 = await answerWorkflow(prisma, spec("a", log), { runId, requestHash: H1, signature: "sig1" });
    assert.strictEqual(r4.status, "pending_signature");
    if (r4.status !== "pending_signature") throw new Error("unreachable");
    assert.strictEqual(r4.runId, runId);
    const H2 = r4.requestHash;
    assert.notStrictEqual(H2, H1);

    // 5. Final answer: generator returns → SUBMITTING with per-run RelayerTx; verify=false keeps it.
    const r5 = await answerWorkflow(prisma, spec("a", log), { runId, requestHash: H2, signature: "sig2" });
    assert.strictEqual(r5.status, "submitting");
    if (r5.status !== "submitting") throw new Error("unreachable");
    assert.strictEqual(r5.transactionId, "tx-a");
    row = await prisma.walletWorkflow.findUniqueOrThrow({ where: { userId_kind: { userId: user.id, kind: "WRAP" } } });
    assert.strictEqual(row.state, "SUBMITTING");
    const relayer = await prisma.relayerTx.findUniqueOrThrow({
      where: { userId_kind_workflowKey: { userId: user.id, kind: "WRAP", workflowKey: runId } },
    });
    assert.strictEqual(relayer.status, "SUBMITTING");

    // 6. Duplicate answer after the fence: stale (single consumer), no second submission.
    const r6 = await answerWorkflow(prisma, spec("a", log), { runId, requestHash: H2, signature: "sig2" });
    assert.strictEqual(r6.status, "stale");
    assert.strictEqual(log.length, 1, "no new generator");

    // 7. Convergence: chain truth flips → start converges to DONE, RelayerTx CONFIRMED.
    verified.value = true;
    const r7 = await startWorkflow(prisma, spec("a", log));
    assert.strictEqual(r7.status, "done");
    row = await prisma.walletWorkflow.findUniqueOrThrow({ where: { userId_kind: { userId: user.id, kind: "WRAP" } } });
    assert.strictEqual(row.state, "DONE");
    const relayer7 = await prisma.relayerTx.findUniqueOrThrow({
      where: { userId_kind_workflowKey: { userId: user.id, kind: "WRAP", workflowKey: runId } },
    });
    assert.strictEqual(relayer7.status, "CONFIRMED");

    // 8. DONE + verify still true = idempotent done (no new run even with different inputs).
    const r8 = await startWorkflow(prisma, spec("b", log, { inputs: { attemptId: "att-2", amountMicro: "999" } }));
    assert.strictEqual(r8.status, "done");
    assert.strictEqual(log.length, 1);

    // 9. DONE + verify false (new deposit epoch) = fresh run with a NEW runId and envelope.
    verified.value = false;
    const r9 = await startWorkflow(prisma, spec("b", log));
    assert.strictEqual(r9.status, "pending_signature");
    if (r9.status !== "pending_signature") throw new Error("unreachable");
    assert.notStrictEqual(r9.runId, runId, "new run id");
    assert.strictEqual(log.length, 2, "fresh generator built");
    const run2 = r9.runId;

    // 10. Lost live session (restart/TTL) mid-signature: the run RESTARTS with a fresh envelope —
    // the stored one is unusable by construction (real nonce/deadline would have drifted).
    _dropLiveSessions();
    const r10 = await startWorkflow(prisma, spec("c", log));
    assert.strictEqual(r10.status, "pending_signature");
    if (r10.status !== "pending_signature") throw new Error("unreachable");
    assert.notStrictEqual(r10.runId, run2, "restarted run");
    assert.strictEqual(log.length, 3);
    // ...and an answer carrying the OLD run's hash is stale, not corrupting.
    const r10b = await answerWorkflow(prisma, spec("c", log), { runId: run2, requestHash: H2, signature: "s" });
    assert.strictEqual(r10b.status, "stale");

    // 11. Expired SUBMITTING + definitelyNotDone → slot releases into a fresh run (B3).
    const rowNow = await prisma.walletWorkflow.findUniqueOrThrow({ where: { userId_kind: { userId: user.id, kind: "WRAP" } } });
    await prisma.walletWorkflow.update({
      where: { userId_kind: { userId: user.id, kind: "WRAP" } },
      data: { state: "SUBMITTING", expiresAt: new Date(Date.now() - 1000) },
    });
    const r11 = await startWorkflow(prisma, spec("d", log));
    assert.strictEqual(r11.status, "pending_signature");
    if (r11.status !== "pending_signature") throw new Error("unreachable");
    assert.notStrictEqual(r11.runId, rowNow.runId, "released and restarted");
    const oldRelayer = await prisma.relayerTx.findUnique({
      where: { userId_kind_workflowKey: { userId: user.id, kind: "WRAP", workflowKey: rowNow.runId! } },
    });
    if (oldRelayer) assert.strictEqual(oldRelayer.status, "FAILED", "expired run's ledger row failed");

    // 12. Factory throw → FAILED, and a retry with the SAME inputs starts a new run (K3 H1).
    const rFail = await startWorkflow(
      prisma,
      spec("e", log, {
        kind: "APPROVALS",
        inputs: { wallet: "0xw" },
        factory: () => {
          throw new Error("rpc down");
        },
      }),
    );
    assert.strictEqual(rFail.status, "failed");
    const rRetry = await startWorkflow(prisma, spec("f", log, { kind: "APPROVALS", inputs: { wallet: "0xw" } }));
    assert.strictEqual(rRetry.status, "pending_signature", "same-inputs retry after FAILED works");

    // 12b. Run-scoped convergence: the relayer's verdict on THIS run's transaction overrides the
    // wallet-wide balance predicates, which can lie in BOTH directions (a concurrent inflow
    // satisfies "done"; a concurrent outflow masks it). So the base spec here lies both ways.
    const verdict = { value: "pending" as TxVerdict };
    const scoped = (marker: string, over: Partial<WorkflowSpec> = {}) =>
      runScoped(
        spec(marker, undefined, {
          kind: "REDEEM",
          inputs: { betId: "b-1" },
          verify: async () => true,
          definitelyNotDone: async () => true,
          ...over,
        }),
        async () => verdict.value,
      );
    const s1 = await startWorkflow(prisma, scoped("s1"));
    assert.strictEqual(s1.status, "pending_signature");
    if (s1.status !== "pending_signature") throw new Error("unreachable");
    const a1 = await answerWorkflow(prisma, scoped("s1"), { runId: s1.runId, requestHash: s1.requestHash, signature: "sig1" });
    assert.strictEqual(a1.status, "pending_signature");
    if (a1.status !== "pending_signature") throw new Error("unreachable");
    const a2 = await answerWorkflow(prisma, scoped("s1"), { runId: s1.runId, requestHash: a1.requestHash, signature: "sig2" });
    assert.strictEqual(a2.status, "submitting", "in-flight tx: base verify=true must NOT converge it");

    // Expired SUBMITTING + still in flight: base definitelyNotDone=true would release the slot and
    // re-submit an operation that may have landed. The verdict holds it.
    const before = await prisma.walletWorkflow.findUniqueOrThrow({ where: { userId_kind: { userId: user.id, kind: "REDEEM" } } });
    await prisma.walletWorkflow.update({
      where: { userId_kind: { userId: user.id, kind: "REDEEM" } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    assert.strictEqual((await startWorkflow(prisma, scoped("s2"))).status, "submitting", "in-flight is never re-driven");

    // Terminal relayer failure is the one case where releasing the slot is safe.
    verdict.value = "failed";
    const s3 = await startWorkflow(prisma, scoped("s3"));
    assert.strictEqual(s3.status, "pending_signature");
    if (s3.status !== "pending_signature") throw new Error("unreachable");
    assert.notStrictEqual(s3.runId, before.runId, "failed verdict releases the slot");

    // Landed converges even though no balance predicate changed.
    verdict.value = "landed";
    const b1 = await answerWorkflow(prisma, scoped("s4"), { runId: s3.runId, requestHash: s3.requestHash, signature: "sig1" });
    assert.strictEqual(b1.status, "pending_signature");
    if (b1.status !== "pending_signature") throw new Error("unreachable");
    const b2 = await answerWorkflow(prisma, scoped("s4"), { runId: s3.runId, requestHash: b1.requestHash, signature: "sig2" });
    assert.strictEqual(b2.status, "done", "landed verdict converges");
    const rel = await prisma.relayerTx.findUniqueOrThrow({
      where: { userId_kind_workflowKey: { userId: user.id, kind: "REDEEM", workflowKey: s3.runId } },
    });
    assert.strictEqual(rel.status, "CONFIRMED");

    // Unknown (probe unreachable / nothing submitted) defers to the base predicate instead of
    // answering for it: verify=false there still means "restart the run".
    verdict.value = "unknown";
    const s5 = await startWorkflow(prisma, scoped("s5", { verify: async () => false }));
    assert.strictEqual(s5.status, "pending_signature", "unknown falls back to the base predicate");

    // 13. Encrypted CLOB-creds roundtrip with AAD binding.
    const originalKey = process.env.REAL_CREDS_KEY;
    process.env.REAL_CREDS_KEY = "ab".repeat(32);
    const creds = { key: "k1", secret: "s1", passphrase: "p1" };
    assert.strictEqual(await saveClobCreds(prisma, user.id, creds), true);
    assert.deepStrictEqual(await loadClobCreds(prisma, user.id), creds);
    // AAD: serving user A's row under user B's id must fail closed. Simulate by re-keying the row.
    const rowA = await prisma.clobCredential.findUniqueOrThrow({ where: { userId: user.id } });
    const userB = await prisma.user.create({
      data: { privyId: `did:privy:${tag}-b`, authProvider: "EMAIL", referralCode: randomCode() },
    });
    await prisma.clobCredential.create({
      data: { userId: userB.id, ciphertext: rowA.ciphertext, nonce: rowA.nonce, keyVersion: rowA.keyVersion },
    });
    assert.strictEqual(await loadClobCreds(prisma, userB.id), null, "row swap fails AAD, not decrypts");
    process.env.REAL_CREDS_KEY = "cd".repeat(32);
    assert.strictEqual(await loadClobCreds(prisma, user.id), null, "wrong key -> null");
    process.env.REAL_CREDS_KEY = "";
    assert.strictEqual(await saveClobCreds(prisma, user.id, creds), false, "no key -> presence-gated false");
    if (originalKey !== undefined) process.env.REAL_CREDS_KEY = originalKey;

    console.log("OK: workflow v2 — live sessions, CAS fence, per-run ledger, convergence, expiry, AAD creds");
    console.log("PASS: workflow");

    await prisma.clobCredential.deleteMany({ where: { userId: userB.id } });
    await prisma.user.deleteMany({ where: { id: userB.id } });
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
