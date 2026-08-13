// Durable signature-relay engine (plan §2.4). Next routes are stateless, so a gasless workflow
// generator cannot live across requests: every request REBUILDS the generator from the row's
// immutable inputs, REPLAYS the stored answers, and requires each regenerated yield to
// byte-match the stored hash — a mismatch means a non-deterministic rebuild and the run fails
// closed (Gate-0 §1.7 validates the SDK side of this assumption).
//
// Crash discipline: answers are persisted and the row enters SUBMITTING BEFORE the generator
// advance that may reach the relayer. A row found in SUBMITTING is NEVER re-driven — ambiguous
// submissions converge from CHAIN state via the caller's verify hook (completeWorkflow), never
// by blind resubmit. RelayerTx is written intent-first in the same fence.
import { createHash } from "node:crypto";
import type { PrismaClient, WalletOpKind } from "@prisma/client";

export type StepRequest = { kind: string; payload?: unknown };
export type WorkflowGen = AsyncGenerator<StepRequest, unknown, string>;

export type DriveResult =
  | { status: "pending_signature"; stepIndex: number; requestHash: string; request: unknown }
  | { status: "submitting"; transactionId: string | null }
  | { status: "done" }
  | { status: "failed"; error: string };

// Deterministic serialization that survives BigInt (typed-data payloads carry them). Used for
// BOTH hashing and Json-column storage so the two can never diverge.
export function safeJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `${v.toString()}n` : v)));
}
export function hashRequest(req: StepRequest): string {
  return createHash("sha256").update(JSON.stringify(safeJson(req))).digest("hex");
}

// Canonical (sorted-keys) stringify for comparing inputs against a Json column round-trip:
// Postgres jsonb does NOT preserve key order (sorts by length, then bytes), so a plain
// JSON.stringify comparison would false-mismatch and reset a DONE run.
function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v as Record<string, unknown>)
              .sort()
              .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
          )
        : v;
  return JSON.stringify(sort(value));
}

type StoredAnswer = { requestHash: string; answer: string };

export async function driveWorkflow(
  prisma: PrismaClient,
  args: {
    userId: string;
    kind: WalletOpKind;
    inputs: unknown; // immutable per run; a DIFFERENT inputs value may reset a DONE/FAILED row
    factory: () => Promise<WorkflowGen> | WorkflowGen;
    // Steps the server may answer itself without a device roundtrip (e.g. requestAddress →
    // the signer address). Must be deterministic — auto-answers are stored and replayed too.
    autoAnswer?: (req: StepRequest) => string | null;
    answer?: { requestHash: string; signature: string };
  },
): Promise<DriveResult> {
  const inputsJson = safeJson(args.inputs);
  const key = { userId_kind: { userId: args.userId, kind: args.kind } };

  let row = await prisma.walletWorkflow.findUnique({ where: key });
  if (!row) {
    row = await prisma.walletWorkflow.create({
      data: { userId: args.userId, kind: args.kind, state: "PENDING_SIGNATURE", inputs: inputsJson as never, answers: [] },
    });
  } else if (row.state === "SUBMITTING") {
    // Ambiguous or in-flight submission: never re-drive. The caller's verify hook converges
    // from chain state and calls completeWorkflow.
    return { status: "submitting", transactionId: row.txHash };
  } else if (row.state === "DONE" || row.state === "FAILED") {
    if (canonicalJson(row.inputs) === canonicalJson(inputsJson)) {
      return row.state === "DONE" ? { status: "done" } : { status: "failed", error: row.error ?? "failed" };
    }
    // New run (the row is the single-flight slot, reused per kind — e.g. one wrap per deposit).
    row = await prisma.walletWorkflow.update({
      where: key,
      data: {
        state: "PENDING_SIGNATURE",
        stepIndex: 0,
        inputs: inputsJson as never,
        answers: [],
        pendingRequest: null as never,
        pendingRequestHash: null,
        txHash: null,
        error: null,
      },
    });
  }

  const answers = (row.answers as StoredAnswer[] | null) ?? [];
  const fail = async (error: string): Promise<DriveResult> => {
    await prisma.walletWorkflow.update({ where: key, data: { state: "FAILED", error } });
    return { status: "failed", error };
  };

  // Rebuild + replay.
  let gen: WorkflowGen;
  let step: IteratorResult<StepRequest, unknown>;
  try {
    gen = await args.factory();
    step = await gen.next();
    for (const stored of answers) {
      if (step.done) return fail("generator finished before replaying all stored answers");
      const h = hashRequest(step.value);
      if (h !== stored.requestHash) {
        return fail(`non-deterministic rebuild: step hash ${h.slice(0, 12)} != stored ${stored.requestHash.slice(0, 12)}`);
      }
      step = await gen.next(stored.answer);
    }
  } catch (e) {
    return fail(`workflow error during replay: ${(e as Error).message}`);
  }

  // Drive forward.
  while (!step.done) {
    const req = step.value;
    const h = hashRequest(req);
    const auto = args.autoAnswer?.(req) ?? null;
    let ans: string | null = auto;
    if (!ans && args.answer && args.answer.requestHash === h) ans = args.answer.signature;
    if (!ans) {
      // Byte-match the UNANSWERED pending request too: if this park lands on the same step as the
      // stored pending but the regenerated request differs, the rebuild diverged — the device may
      // hold a signature over a payload that no longer exists. Fail closed (§2.4).
      if (row.pendingRequestHash && answers.length === row.stepIndex && row.pendingRequestHash !== h) {
        return fail(
          `non-deterministic rebuild: pending request changed (${h.slice(0, 12)} != stored ${row.pendingRequestHash.slice(0, 12)})`,
        );
      }
      // Park: persist the pending request; the device signs it and the next call resumes here.
      // Re-serving the SAME stored payload on retry is what makes a lost response safe.
      await prisma.walletWorkflow.update({
        where: key,
        data: {
          state: "PENDING_SIGNATURE",
          stepIndex: answers.length,
          pendingRequest: safeJson(req) as never,
          pendingRequestHash: h,
        },
      });
      return { status: "pending_signature", stepIndex: answers.length, requestHash: h, request: safeJson(req) };
    }

    // Crash fence: answer + SUBMITTING + intent-first RelayerTx land BEFORE the advance that may
    // reach the relayer. attempts increments on every fence pass = per-submission counting.
    answers.push({ requestHash: h, answer: ans });
    await prisma.$transaction([
      prisma.walletWorkflow.update({
        where: key,
        data: { state: "SUBMITTING", answers: answers as never, stepIndex: answers.length, pendingRequest: null as never, pendingRequestHash: null },
      }),
      prisma.relayerTx.upsert({
        where: { userId_kind_workflowKey: { userId: args.userId, kind: args.kind, workflowKey: row.id } },
        create: { userId: args.userId, kind: args.kind, workflowKey: row.id, status: "SUBMITTING" },
        update: { attempts: { increment: 1 }, status: "SUBMITTING" },
      }),
    ]);

    try {
      step = await gen.next(ans);
    } catch (e) {
      // The advance itself failed. State stays SUBMITTING deliberately: whether the relayer saw
      // the call is unknown — converge from chain, or a human resolves it. Record the error text.
      await prisma.walletWorkflow.update({ where: key, data: { error: `advance failed: ${(e as Error).message}` } });
      await prisma.relayerTx.update({
        where: { userId_kind_workflowKey: { userId: args.userId, kind: args.kind, workflowKey: row.id } },
        data: { status: "FAILED" },
      });
      return { status: "submitting", transactionId: null };
    }

    if (!step.done) {
      // That advance only yielded another request — the fence was transient; fall through and
      // the loop parks or answers it. (State corrects to PENDING_SIGNATURE when parking.)
      continue;
    }
  }

  // Generator returned: submission handed to the relayer. Store the transaction id and stay in
  // SUBMITTING until the caller's chain-state verify confirms (completeWorkflow).
  const result = step.value as { transactionId?: string } | undefined | void;
  const txId = (result && typeof result === "object" && result.transactionId) || null;
  await prisma.walletWorkflow.update({ where: key, data: { txHash: txId } });
  return { status: "submitting", transactionId: txId };
}

// Chain-state convergence: the caller verified the operation's effect (allowance present, USDC.e
// consumed, pUSD minted) — or definitively its failure — and closes the run.
export async function completeWorkflow(
  prisma: PrismaClient,
  userId: string,
  kind: WalletOpKind,
  outcome: { ok: true; txHash?: string | null } | { ok: false; error: string },
): Promise<void> {
  const key = { userId_kind: { userId, kind } };
  const row = await prisma.walletWorkflow.findUnique({ where: key });
  if (!row || row.state === "DONE") return;
  if (outcome.ok) {
    await prisma.walletWorkflow.update({
      where: key,
      data: { state: "DONE", txHash: outcome.txHash ?? row.txHash, error: null },
    });
    await prisma.relayerTx.updateMany({
      where: { userId, kind, workflowKey: row.id },
      data: { status: "CONFIRMED", txHash: outcome.txHash ?? undefined },
    });
  } else {
    await prisma.walletWorkflow.update({ where: key, data: { state: "FAILED", error: outcome.error } });
    await prisma.relayerTx.updateMany({ where: { userId, kind, workflowKey: row.id }, data: { status: "FAILED" } });
  }
}
