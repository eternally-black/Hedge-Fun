// Durable signature-relay engine, v2 (plan §2.4, reworked after the S4 cross-review).
//
// WHY NOT rebuild-and-replay: the real SDK generator is non-deterministic BY CONSTRUCTION —
// buildDepositWalletExecuteRequest refetches the wallet nonce and stamps deadline=Date.now()+600
// on every build (verified in 0.6.0 source; Sol S4-critical). So the generator lives IN MEMORY
// for the seconds-long signature roundtrip (one app container — compose topology), keyed by a
// per-RUN id. The DB row is the single-flight slot, the SUBMIT fence, and observability:
//   - lost live session BEFORE the fence (restart/TTL) → the run restarts cleanly with a fresh
//     generator (new nonce/deadline, one extra device prompt) — the honest outcome;
//   - after the fence (SUBMITTING) → NEVER re-driven; converge from chain state via the caller's
//     verify hook, or expire into FAILED when the op verifiably never happened.
// All transitions are CAS (updateMany qualified on prior state+runId): two devices can race, only
// one advances (K3 B4). RelayerTx rows are PER RUN (workflowKey = runId) — the budget ledger
// survives slot reuse (K3 H3).
import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient, WalletOpKind, WalletWorkflow } from "@prisma/client";

export type StepRequest = { kind: string; payload?: unknown };
export type WorkflowGen = AsyncGenerator<StepRequest, unknown, string>;

export type WorkflowResult =
  | { status: "pending_signature"; runId: string; requestHash: string; request: unknown }
  | { status: "submitting"; runId: string; transactionId: string | null; error: string | null }
  | { status: "done" }
  | { status: "failed"; error: string }
  | { status: "stale" }; // caller's runId/answer no longer matches — client re-POSTs start

export function safeJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `${v.toString()}n` : v)));
}
function sortKeys(v: unknown): unknown {
  return Array.isArray(v)
    ? v.map(sortKeys)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v as Record<string, unknown>)
            .sort()
            .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
        )
      : v;
}
export function hashRequest(req: StepRequest): string {
  return createHash("sha256").update(JSON.stringify(sortKeys(safeJson(req)))).digest("hex");
}

// ---------------------------------------------------------------- live generator sessions
const LIVE_TTL_MS = 5 * 60 * 1000;
const SUBMIT_EXPIRY_MS = 10 * 60 * 1000;
// The relayer envelope carries deadline = build-time + 600s (SDK source): re-serving an older
// session invites signing a dead envelope, so sessions hard-expire on AGE, not just idle time.
const ENVELOPE_TTL_MS = 8 * 60 * 1000;
type LiveSession = { gen: WorkflowGen; at: number; bornAt: number };
const live = new Map<string, LiveSession>(); // runId → session

function sweepLive(now: number): void {
  for (const [k, s] of live) if (now - s.at > LIVE_TTL_MS) live.delete(k);
}
// Test hook: simulate a process restart / TTL loss.
export function _dropLiveSessions(): void {
  live.clear();
}

export interface WorkflowSpec {
  userId: string;
  kind: WalletOpKind;
  inputs: unknown; // immutable per run, persisted for observability + convergence params
  factory: () => Promise<WorkflowGen> | WorkflowGen;
  autoAnswer?: (req: StepRequest) => string | null;
  // Chain-state truth: has the operation's EFFECT landed? Consulted for DONE idempotency and
  // SUBMITTING convergence. Must read chain (or watcher-observed finalized state), never the op.
  verify: () => Promise<boolean>;
  // For an expired SUBMITTING row: did the operation verifiably NOT happen (safe to reset)?
  // Approvals are idempotent on-chain, so `true` is safe there even when ambiguous.
  definitelyNotDone: () => Promise<boolean>;
}

const key = (userId: string, kind: WalletOpKind) => ({ userId_kind: { userId, kind } });

async function park(
  prisma: PrismaClient,
  row: { userId: string; kind: WalletOpKind; runId: string | null },
  fromState: "PENDING_SIGNATURE" | "SUBMITTING",
  req: StepRequest,
  stepIndex: number,
): Promise<WorkflowResult> {
  const h = hashRequest(req);
  const res = await prisma.walletWorkflow.updateMany({
    where: { userId: row.userId, kind: row.kind, runId: row.runId, state: fromState },
    data: { state: "PENDING_SIGNATURE", stepIndex, pendingRequest: safeJson(req) as never, pendingRequestHash: h },
  });
  if (res.count === 0) return { status: "stale" };
  return { status: "pending_signature", runId: row.runId ?? "", requestHash: h, request: safeJson(req) };
}

// Advance a LIVE generator from `state` until it parks on a device signature, finishes, or throws.
async function run(
  prisma: PrismaClient,
  spec: WorkflowSpec,
  row: WalletWorkflow,
  gen: WorkflowGen,
  firstAnswer?: string,
): Promise<WorkflowResult> {
  let step: IteratorResult<StepRequest, unknown>;
  let stepIndex = row.stepIndex;
  let feeding = firstAnswer;
  try {
    while (true) {
      // The fence: EVERY advance may reach the relayer (the SDK submits internally, with its own
      // retries), so the row is SUBMITTING + a per-run RelayerTx exists BEFORE gen.next().
      if (feeding !== undefined) {
        const fence = await prisma.$transaction(async (tx) => {
          const claimed = await tx.walletWorkflow.updateMany({
            where: { userId: spec.userId, kind: spec.kind, runId: row.runId, state: { in: ["PENDING_SIGNATURE", "SUBMITTING"] } },
            data: { state: "SUBMITTING", expiresAt: new Date(Date.now() + SUBMIT_EXPIRY_MS) },
          });
          if (claimed.count === 0) return false;
          // attempts counts SUBMISSIONS, not generator advances (K3): 0 at fence time; the
          // completion/failure paths below increment when a submit actually (or ambiguously) ran.
          await tx.relayerTx.upsert({
            where: { userId_kind_workflowKey: { userId: spec.userId, kind: spec.kind, workflowKey: row.runId! } },
            create: { userId: spec.userId, kind: spec.kind, workflowKey: row.runId!, status: "SUBMITTING", attempts: 0 },
            update: { status: "SUBMITTING" },
          });
          return true;
        });
        if (!fence) return { status: "stale" };
        step = await gen.next(feeding);
        stepIndex++;
        feeding = undefined;
      } else {
        step = await gen.next();
      }

      if (step.done) break;
      const req = step.value;
      const auto = spec.autoAnswer?.(req) ?? null;
      if (auto !== null) {
        feeding = auto;
        continue;
      }
      const existing = live.get(row.runId!);
      live.set(row.runId!, { gen, at: Date.now(), bornAt: existing?.bornAt ?? Date.now() });
      return park(prisma, row, "SUBMITTING", req, stepIndex);
    }
  } catch (e) {
    // The advance failed. Whether the relayer saw it is unknown → stay SUBMITTING with the error;
    // convergence or expiry resolves it. RelayerTx mirrors the failure.
    live.delete(row.runId!);
    const msg = `advance failed: ${(e as Error).message}`;
    await prisma.walletWorkflow.updateMany({
      where: { userId: spec.userId, kind: spec.kind, runId: row.runId, state: "SUBMITTING" },
      data: { error: msg },
    });
    await prisma.relayerTx.updateMany({
      where: { userId: spec.userId, kind: spec.kind, workflowKey: row.runId! },
      data: { status: "FAILED", attempts: { increment: 1 } }, // ambiguous submit counts as one
    });
    return { status: "submitting", runId: row.runId!, transactionId: null, error: msg };
  }

  // Generator returned — submission handed off. Record the relayer transaction id (NOT a chain
  // hash; convergence supplies that) and try immediate convergence.
  live.delete(row.runId!);
  const result = step.value as { transactionId?: string } | undefined | void;
  const txId = (result && typeof result === "object" && result.transactionId) || null;
  await prisma.walletWorkflow.updateMany({
    where: { userId: spec.userId, kind: spec.kind, runId: row.runId },
    data: { txHash: txId },
  });
  await prisma.relayerTx.updateMany({
    where: { userId: spec.userId, kind: spec.kind, workflowKey: row.runId! },
    data: { attempts: { increment: 1 }, txHash: txId }, // one real submission handed off
  });
  if (await tryConverge(prisma, spec, row.runId!)) return { status: "done" };
  return { status: "submitting", runId: row.runId!, transactionId: txId, error: null };
}

async function tryConverge(prisma: PrismaClient, spec: WorkflowSpec, runId: string): Promise<boolean> {
  try {
    if (!(await spec.verify())) return false;
  } catch {
    return false; // verification unavailable ≠ verified
  }
  await prisma.walletWorkflow.updateMany({
    where: { userId: spec.userId, kind: spec.kind, runId, state: { not: "DONE" } },
    data: { state: "DONE", error: null },
  });
  // FAILED included: an advance that threw but whose submission actually landed must not leave a
  // contradictory WalletWorkflow=DONE / RelayerTx=FAILED pair (Sol S4-recheck #9).
  await prisma.relayerTx.updateMany({
    where: { userId: spec.userId, kind: spec.kind, workflowKey: runId, status: { in: ["SUBMITTING", "FAILED"] } },
    data: { status: "CONFIRMED" },
  });
  return true;
}

async function freshRun(
  prisma: PrismaClient,
  spec: WorkflowSpec,
  // The reset is CAS-qualified on the EXACT prior row observed — a request that read DONE/FAILED/
  // lost-PENDING must not overwrite a run another request has since advanced (Sol S4-recheck #2).
  prior: { state: WalletWorkflow["state"]; runId: string | null } | null,
): Promise<WorkflowResult> {
  const runId = randomUUID();
  const data = {
    state: "PENDING_SIGNATURE" as const,
    runId,
    stepIndex: 0,
    inputs: safeJson(spec.inputs) as never,
    answers: [] as never,
    pendingRequest: null as never,
    pendingRequestHash: null,
    txHash: null,
    error: null,
    expiresAt: null,
  };
  let row: WalletWorkflow;
  if (prior) {
    const reset = await prisma.walletWorkflow.updateMany({
      where: { userId: spec.userId, kind: spec.kind, state: prior.state, runId: prior.runId },
      data,
    });
    if (reset.count === 0) return { status: "stale" }; // someone else moved the slot — re-enter
    row = await prisma.walletWorkflow.findUniqueOrThrow({ where: key(spec.userId, spec.kind) });
  } else {
    try {
      row = await prisma.walletWorkflow.create({ data: { userId: spec.userId, kind: spec.kind, ...data } });
    } catch {
      // First-call race (K3 L2): the loser re-enters through the normal path.
      return { status: "stale" };
    }
  }
  let gen: WorkflowGen;
  try {
    gen = await spec.factory();
  } catch (e) {
    // Factory failures are transient by default (network at construction) — release the slot.
    const msg = `factory failed: ${(e as Error).message}`;
    await prisma.walletWorkflow.updateMany({
      where: { userId: spec.userId, kind: spec.kind, runId },
      data: { state: "FAILED", error: msg },
    });
    return { status: "failed", error: msg };
  }
  return run(prisma, spec, row, gen);
}

// Entry point 1: start-or-status. No answer — returns the current state, re-serving the pending
// request when the live session still exists, restarting the run when it was lost.
export async function startWorkflow(prisma: PrismaClient, spec: WorkflowSpec): Promise<WorkflowResult> {
  sweepLive(Date.now());
  const row = await prisma.walletWorkflow.findUnique({ where: key(spec.userId, spec.kind) });
  if (!row) return freshRun(prisma, spec, null);
  // Pre-rework (v1) rows have runId NULL and inputs the v2 closures can't drive — converging or
  // expiring them would 500 on the non-nullable workflowKey filter (K3). Restart them cleanly.
  if (!row.runId) return freshRun(prisma, spec, { state: row.state, runId: null });

  switch (row.state) {
    case "DONE": {
      // Convergence-driven idempotency: still verified → done; effect gone/new run wanted → restart.
      try {
        if (await spec.verify()) return { status: "done" };
      } catch {
        return { status: "done" }; // can't verify right now — don't burn a run on it
      }
      return freshRun(prisma, spec, { state: row.state, runId: row.runId });
    }
    case "FAILED":
      return freshRun(prisma, spec, { state: row.state, runId: row.runId }); // same-inputs retry is legal (K3 H1)
    case "SUBMITTING": {
      if (await tryConverge(prisma, spec, row.runId!)) return { status: "done" };
      const expired = row.expiresAt !== null && row.expiresAt.getTime() < Date.now();
      if (expired && (await spec.definitelyNotDone().catch(() => false))) {
        await prisma.relayerTx.updateMany({
          where: { userId: spec.userId, kind: spec.kind, workflowKey: row.runId!, status: "SUBMITTING" },
          data: { status: "FAILED" },
        });
        return freshRun(prisma, spec, { state: row.state, runId: row.runId }); // verifiably never happened — release the slot (K3 B3)
      }
      return { status: "submitting", runId: row.runId!, transactionId: row.txHash, error: row.error };
    }
    case "PENDING_SIGNATURE": {
      const session = row.runId ? live.get(row.runId) : undefined;
      if (session && Date.now() - session.bornAt > ENVELOPE_TTL_MS) {
        // The envelope's relayer deadline is fixed at build time — re-serving past it invites
        // signing a dead payload. Drop the session; the branch below restarts the run.
        live.delete(row.runId!);
        return freshRun(prisma, spec, { state: row.state, runId: row.runId });
      }
      if (session && row.pendingRequest && row.pendingRequestHash) {
        session.at = Date.now();
        return {
          status: "pending_signature",
          runId: row.runId!,
          requestHash: row.pendingRequestHash,
          request: row.pendingRequest,
        };
      }
      // Live generator lost (restart / TTL): the stored envelope is unusable by construction
      // (fresh nonce+deadline next build) — restart the run honestly.
      return freshRun(prisma, spec, { state: row.state, runId: row.runId });
    }
  }
}

// Entry point 2: the device answered the pending request.
export async function answerWorkflow(
  prisma: PrismaClient,
  spec: WorkflowSpec,
  answer: { runId: string; requestHash: string; signature: string },
): Promise<WorkflowResult> {
  sweepLive(Date.now());
  const row = await prisma.walletWorkflow.findUnique({ where: key(spec.userId, spec.kind) });
  if (
    !row ||
    row.state !== "PENDING_SIGNATURE" ||
    row.runId !== answer.runId ||
    row.pendingRequestHash !== answer.requestHash
  ) {
    return { status: "stale" };
  }
  const session = live.get(answer.runId);
  if (!session) return freshRun(prisma, spec, { state: row.state, runId: row.runId }); // lost session → new envelope to sign
  live.delete(answer.runId); // single consumer: a concurrent duplicate answer goes stale
  const answers = ((row.answers as Array<{ requestHash: string; answer: string }> | null) ?? []).concat({
    requestHash: answer.requestHash,
    answer: answer.signature,
  });
  await prisma.walletWorkflow.updateMany({
    where: { userId: spec.userId, kind: spec.kind, runId: row.runId },
    data: { answers: answers as never },
  });
  return run(prisma, spec, row, session.gen, answer.signature);
}

// ---------------------------------------------------------------- run-scoped convergence
// The convergence predicates above are supplied by the caller as wallet-wide balance reads, and
// those are SHARED mutable state: a concurrent fill, wrap or withdrawal can satisfy one (false
// DONE — the op never happened) or mask one (false "verifiably nothing happened" → a second
// submission of an op that already landed). K3 S6/S7 MEDIUM-1: the same defect in three costumes.
// The run-scoped truth is the relayer transaction this run handed off — persisted in
// WalletWorkflow.txHash (the relayer transactionId, NOT a chain hash) and readable per-run, so no
// other flow can move it. A definite relayer verdict therefore OVERRIDES the balance predicate;
// "unknown" (probe unreachable, or nothing submitted yet) falls back to it unchanged.
// Known ceiling: a tx that never leaves a non-terminal relayer state holds the slot in SUBMITTING
// instead of releasing it at expiry — honest (we must not re-submit what may have landed), but
// only the relayer can resolve it.
export type TxVerdict = "landed" | "failed" | "pending" | "unknown";

export function runScoped(spec: WorkflowSpec, verdict: () => Promise<TxVerdict>): WorkflowSpec {
  const ask = async (): Promise<TxVerdict> => {
    try {
      return await verdict();
    } catch {
      return "unknown";
    }
  };
  return {
    ...spec,
    verify: async () => {
      const v = await ask();
      return v === "unknown" ? spec.verify() : v === "landed";
    },
    definitelyNotDone: async () => {
      const v = await ask();
      return v === "unknown" ? spec.definitelyNotDone() : v === "failed";
    },
  };
}
