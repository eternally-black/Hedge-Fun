// POST /api/real/workflow — the device-facing end of the durable signature relay (plan §2.4 v2).
// Body: { kind: "APPROVALS" | "WRAP", answer?: { runId, requestHash, signature } }.
// No answer → start-or-status (re-serves the live pending request; restarts a lost run).
// With answer → advance the LIVE generator. status "stale" → the client re-POSTs start.
// Convergence is CHAIN state read through our own RPC helper — never the CLOB's cached view
// (S4 review: fetchBalanceAllowance is a server-side cache AND its shape was misread; approvals
// use our EXPLICIT alpha call set instead of the SDK's generic MAX_UINT-to-everything setup).
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import { isRealMoneyEligible, hasRealConsent, sameOrigin } from "@/lib/real";
import { rateLimit } from "@/lib/ratelimit";
import { captureToGlitchTip, sendOpsTelegram } from "@/lib/glitchtip";
import { serverSecureClient } from "@/lib/polymarket-server";
import { relayerVerdict } from "@/lib/relayer-verdict";
import { bridgeOutSpec, type BridgeOutInputs } from "@/lib/bridge-out";
import { buildWrapCalls, buildApprovalCalls } from "@/lib/wallet-ops";
import {
  startWorkflow,
  answerWorkflow,
  runScoped,
  type WorkflowGen,
  type WorkflowSpec,
  type StepRequest,
} from "@/lib/workflow";
import { erc20BalanceOf, USDCE_ADDRESS, PUSD_ADDRESS } from "@/lib/polygon";
import { isTradingReady } from "@/lib/trading-ready";
import { planRedeem } from "@/lib/redeem";
import { consumeResolvedPosition } from "@/lib/real-settle";
import {
  prepareGaslessTransaction,
  prepareRedeemPositions,
  planCollateralReturn,
  prepareCollateralReturnExecution,
} from "@polymarket/client/actions";

const KINDS = ["APPROVALS", "WRAP", "REDEEM", "WITHDRAW", "BRIDGE_OUT"] as const;
type Kind = (typeof KINDS)[number];

const EVM_SIG = /^0x[0-9a-fA-F]{130}$/; // validate BEFORE the fence — the SDK throws on garbage inside it

// Run-scoped convergence probe (K3 S6/S7 MEDIUM-1). The relayer's own view of THIS run's
// transaction — no other flow can move it, unlike the wallet-wide pUSD balance the predicates
// below read. State semantics are the SDK's own (TransactionHandle.wait): STATE_CONFIRMED =
// landed, STATE_FAILED/STATE_INVALID = terminal failure, everything else still in flight.
// Never cached: txHash legitimately changes mid-request when a run restarts.

export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasRealConsent(user)) return NextResponse.json({ error: "consent_required" }, { status: 403 });
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  // Generous — the relay loop legitimately POSTs several times per run — but bounded: every start
  // can reach the relayer and the chain RPC.
  if (!rateLimit(`real-workflow:${user.id}`, 60, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  const wallet = user.depositWalletAddress;
  const signerAddress = user.embeddedWalletAddress;
  if (!wallet || !signerAddress) return NextResponse.json({ error: "no_deposit_wallet" }, { status: 409 });

  let kind: Kind;
  let answer: { runId: string; requestHash: string; signature: string } | undefined;
  try {
    const body = await req.json();
    if (!KINDS.includes(body?.kind)) return NextResponse.json({ error: "bad_kind" }, { status: 400 });
    kind = body.kind;
    if (body.answer) {
      const a = body.answer;
      if (typeof a.runId !== "string" || typeof a.requestHash !== "string" || typeof a.signature !== "string") {
        return NextResponse.json({ error: "bad_answer" }, { status: 400 });
      }
      // requestAddress answers are addresses, everything else is a 65-byte signature. The engine
      // auto-answers addresses server-side, so a device answer must be signature-shaped.
      if (!EVM_SIG.test(a.signature)) return NextResponse.json({ error: "bad_signature_shape" }, { status: 400 });
      answer = { runId: a.runId, requestHash: a.requestHash, signature: a.signature };
    }
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  // The env allowlist gates GETTING IN (funding-side verbs); the funds-recovery verbs REDEEM and
  // WITHDRAW must survive a flag flip or a removed tester — trapping balances behind an env list
  // is the harm the close-only tier exists to prevent (K3 S6/S7 M3). Identity+consent still gate.
  if ((kind === "APPROVALS" || kind === "WRAP") && !isRealMoneyEligible(user)) {
    return NextResponse.json({ error: "real_disabled" }, { status: 403 });
  }

  const client = await serverSecureClient(prisma, user);
  if (!client) return NextResponse.json({ error: "real_not_configured" }, { status: 503 });

  let spec: WorkflowSpec;
  let onDone: (() => Promise<void>) | null = null;
  if (kind === "WRAP") {
    // The run binds to a specific funding attempt; amount pins to the watcher-observed FINALIZED
    // balance. SUBMITTING/DONE handling never re-reads the current attempt (S4 review B2) — the
    // engine converges against the RUN's own inputs via the closures below.
    const attempt = await prisma.fundingAttempt.findFirst({
      where: { userId: user.id, state: "DETECTED" },
      orderBy: { declaredAt: "desc" },
    });
    const row = await prisma.walletWorkflow.findUnique({ where: { userId_kind: { userId: user.id, kind: "WRAP" } } });
    const active = row && (row.state === "PENDING_SIGNATURE" || row.state === "SUBMITTING");
    // Priority: an ACTIVE run drives on its own persisted inputs regardless of what the watcher
    // did to the attempt since (FUNDED included); a DETECTED attempt starts a fresh run; a DONE
    // row with neither stays idempotently DONE instead of 409ing (Sol S4-recheck #7).
    const runInputs = active
      ? (row.inputs as { attemptId: string; wallet: string; amountMicro: string })
      : attempt && attempt.latestUsdceMicro > 0n
        ? { attemptId: attempt.id, wallet, amountMicro: attempt.latestUsdceMicro.toString() }
        : row?.state === "DONE"
          ? (row.inputs as { attemptId: string; wallet: string; amountMicro: string })
          : null;
    if (!runInputs) return NextResponse.json({ error: "nothing_to_wrap" }, { status: 409 });
    const amount = BigInt(runInputs.amountMicro);
    spec = {
      userId: user.id,
      kind,
      inputs: runInputs,
      factory: () =>
        prepareGaslessTransaction(client, {
          calls: buildWrapCalls(runInputs.wallet, amount).map((c) => ({ to: c.to, data: c.data as `0x${string}` })),
          metadata: "HedgeFun wrap USDC.e -> pUSD",
        }) as Promise<WorkflowGen>,
      autoAnswer: (r: StepRequest) => (r.kind === "requestAddress" ? signerAddress : null),
      // Wrap converts amount USDC.e → amount pUSD 1:1: verified when the RUN's attempt shows a
      // finalized pUSD delta covering the amount (the §6.2 rule — pUSD is the only spendable signal).
      verify: async () => {
        const a = await prisma.fundingAttempt.findUnique({ where: { id: runInputs.attemptId } });
        if (!a) return false;
        const pusd = await erc20BalanceOf(PUSD_ADDRESS, runInputs.wallet);
        return pusd - a.baselinePusdMicro >= amount;
      },
      // Safe to reset only when verifiably nothing happened: USDC.e still sits unconverted.
      definitelyNotDone: async () => {
        const [usdce, pusd] = await Promise.all([
          erc20BalanceOf(USDCE_ADDRESS, runInputs.wallet),
          erc20BalanceOf(PUSD_ADDRESS, runInputs.wallet),
        ]);
        const a = await prisma.fundingAttempt.findUnique({ where: { id: runInputs.attemptId } });
        return usdce >= amount && (a ? pusd - a.baselinePusdMicro < amount : false);
      },
    };
  } else if (kind === "REDEEM") {
    // Redeem burns resolved outcome tokens → pUSD. Binds the newest REAL bet on a TERMINAL market
    // (RESOLVED or CANCELED — invalid resolutions land as CANCELED/INVALID and PUSH; K3 S6/S7
    // HIGH-1.2) that still has a redeemable remainder — the remainder predicate can't live in a
    // Prisma where, so scan a small window instead of newest-or-nothing (HIGH-1.3).
    const candidates = await prisma.bet.findMany({
      where: { userId: user.id, mode: "REAL", market: { status: { in: ["RESOLVED", "CANCELED"] } } },
      orderBy: { createdAt: "desc" },
      include: { market: true },
      take: 10,
    });
    const row = await prisma.walletWorkflow.findUnique({ where: { userId_kind: { userId: user.id, kind: "REDEEM" } } });
    const active = row && (row.state === "PENDING_SIGNATURE" || row.state === "SUBMITTING");
    type RedeemInputs = {
      conditionId: string;
      wallet: string;
      pusdBaseline: string;
      betId: string;
      won: boolean;
      canceled?: boolean; // absent on rows persisted before the CANCELED $0.50/share fix
      remainderMicro: string;
    };
    // Pick what to bind. `won`: CANCELED = push (collateral returns, converge like a win); else
    // side === outcome (executor-review fix: the generated comparison was inverted). Two candidate
    // classes never reach a run at all:
    //   LOST (pre-Gate-0 item 6) — redeems to zero collateral, so a run would spend a device
    //     prompt and a relayer submission to move no money, with a convergence arm that cannot
    //     tell did-it-run from didn't. Book it here and move on.
    //   WINNER — the first eligible one binds. Neg-risk winners are ordinary winners now: the
    //     alpha approval set grants the neg-risk collateral adapter, which is what performs their
    //     redemption.
    // The classification itself is pure and lives in lib/redeem.ts (this route can't be tested —
    // it imports the SDK); here we only ACT on the plan.
    const plan = active ? { bind: null, losses: [] } : planRedeem(candidates);
    let lossesBooked = 0;
    for (const l of plan.losses) if (await consumeResolvedPosition(prisma, l.id, false, false)) lossesBooked++;
    const boundBet = plan.bind ? candidates.find((c) => c.id === plan.bind!.id) ?? null : null;
    // Mirror the WRAP pattern: an ACTIVE run drives on its own persisted inputs; a DONE row with
    // nothing new to redeem answers idempotent done; otherwise require a redeemable position.
    const runInputs: RedeemInputs | null = active
      ? (row.inputs as RedeemInputs)
      : boundBet
        ? {
            conditionId: boundBet.market.polymarketId,
            wallet,
            pusdBaseline: (await erc20BalanceOf(PUSD_ADDRESS, wallet)).toString(),
            betId: boundBet.id,
            won: true, // bound candidates are winners by construction — losers were booked above
            canceled: boundBet.market.status === "CANCELED", // a push redeems $0.50/share, not $1.00
            remainderMicro: ((boundBet.filledSharesMicro ?? 0n) - (boundBet.closedSharesMicro ?? 0n)).toString(),
          }
        : row?.state === "DONE"
          ? (row.inputs as RedeemInputs)
          : null;
    if (!runInputs) {
      // Losses ARE the work when there is nothing to redeem — they were just booked and consumed.
      if (lossesBooked > 0) return NextResponse.json({ status: "done", lossesBooked });
      return NextResponse.json({ error: "nothing_to_redeem" }, { status: 409 });
    }
    // Consume the position on convergence (K3 HIGH-1.4): without this the same bet rebinds on
    // every poll — a fresh signature prompt and a burned relayer submission per cycle.
    onDone = async () => {
      // `canceled` arrived with the INVALID-payout fix, so a run persisted BEFORE it carries only
      // `won`. Defaulting that to false would quietly restore the very bug the flag exists to kill:
      // an in-flight pre-fix run on a canceled market books $1.00/share against a payout that pays
      // $0.50. Re-derive from the market instead — it is the same source planRedeem classifies from.
      const canceled =
        runInputs.canceled ??
        (
          await prisma.bet.findUnique({
            where: { id: runInputs.betId },
            select: { market: { select: { status: true } } },
          })
        )?.market.status === "CANCELED";
      await consumeResolvedPosition(prisma, runInputs.betId, runInputs.won, canceled);
    };
    spec = {
      userId: user.id,
      kind,
      inputs: runInputs,
      factory: () =>
        prepareRedeemPositions(client, { conditionId: runInputs.conditionId } as never) as Promise<WorkflowGen>,
      autoAnswer: (r: StepRequest) => (r.kind === "requestAddress" ? signerAddress : null),
      // A win (or INVALID push) redeems to collateral — pUSD increases past the run baseline. The
      // loss arms below are dead for NEW runs (losers never bind any more, item 6) but must stay:
      // an ACTIVE row persisted before this change can still carry `won: false`.
      verify: async () => {
        if (!runInputs.won) return true;
        const pusd = await erc20BalanceOf(PUSD_ADDRESS, runInputs.wallet);
        return pusd > BigInt(runInputs.pusdBaseline);
      },
      // For losers we can never distinguish did-it-run from didn't — ambiguity keeps the slot
      // until expiry (approvals-style idempotency does not apply to redemption).
      definitelyNotDone: async () => {
        if (!runInputs.won) return false;
        const pusd = await erc20BalanceOf(PUSD_ADDRESS, runInputs.wallet);
        return pusd <= BigInt(runInputs.pusdBaseline);
      },
    };
  } else if (kind === "WITHDRAW") {
    // Collateral-return: pUSD leaves the deposit wallet. The plan is fetched INSIDE the factory —
    // once per run, so the two-phase plan→execute shape is safe under the live-session engine.
    // WHERE the funds land (signer EOA vs bridge-out toward Solana) is a Gate-0 question — this
    // workflow proves the mechanism; the destination leg is verified live (owner Q2 full cycle).
    const pusd = await erc20BalanceOf(PUSD_ADDRESS, wallet);
    const row = await prisma.walletWorkflow.findUnique({ where: { userId_kind: { userId: user.id, kind: "WITHDRAW" } } });
    const active = row && (row.state === "PENDING_SIGNATURE" || row.state === "SUBMITTING");
    type WithdrawInputs = { wallet: string; pusdBaseline: string };
    const runInputs: WithdrawInputs | null = active
      ? (row.inputs as WithdrawInputs)
      : pusd > 0n
        ? { wallet, pusdBaseline: pusd.toString() }
        : row?.state === "DONE"
          ? (row.inputs as WithdrawInputs)
          : null;
    if (!runInputs) return NextResponse.json({ error: "nothing_to_withdraw" }, { status: 409 });
    spec = {
      userId: user.id,
      kind,
      inputs: runInputs,
      factory: async () => {
        const plan = await planCollateralReturn(client);
        // The service TRUNCATES a plan it cannot fit in one router call (Sol's deferred chunking
        // question): this run then drains only part of the balance and converges anyway, because
        // convergence only asks whether pUSD went DOWN. The next POST re-binds while pUSD > 0, so
        // the remainder does drain — but silently, which is the wrong way for money to behave.
        const p = plan as unknown as { truncated?: boolean; operationCount?: number; netPusdOut?: string };
        if (p.truncated) {
          console.warn(`[real] withdraw plan truncated: ${p.operationCount} ops, netPusdOut ${p.netPusdOut}`);
          void sendOpsTelegram(
            `[real] withdrawal plan TRUNCATED for ${user.id}: ${p.operationCount ?? "?"} operations, ` +
              `netPusdOut ${p.netPusdOut ?? "?"} — this run drains part of the balance; the user must run withdrawal again`,
          );
        }
        return (await prepareCollateralReturnExecution(client, { plan } as never)) as WorkflowGen;
      },
      autoAnswer: (r: StepRequest) => (r.kind === "requestAddress" ? signerAddress : null),
      // Collateral left the wallet: pUSD decreased from the run baseline.
      verify: async () => {
        const now = await erc20BalanceOf(PUSD_ADDRESS, runInputs.wallet);
        return now < BigInt(runInputs.pusdBaseline);
      },
      // Nothing left yet — safe to reset.
      definitelyNotDone: async () => {
        const now = await erc20BalanceOf(PUSD_ADDRESS, runInputs.wallet);
        return now >= BigInt(runInputs.pusdBaseline);
      },
    };
  } else if (kind === "BRIDGE_OUT") {
    // The single-purpose bridge address is minted by POST /api/real/withdraw and NEVER here. The
    // split is the whole safety property: each address forwards whatever lands on it to the
    // recipient it was created for, so a retry that minted a fresh one would leave live
    // forwarding addresses lying around. This arm only drives a run that already exists.
    const row = await prisma.walletWorkflow.findUnique({
      where: { userId_kind: { userId: user.id, kind: "BRIDGE_OUT" } },
    });
    if (!row || (row.state !== "PENDING_SIGNATURE" && row.state !== "SUBMITTING" && row.state !== "DONE")) {
      return NextResponse.json({ error: "no_withdrawal_pending" }, { status: 409 });
    }
    const runInputs = row.inputs as unknown as BridgeOutInputs;
    spec = bridgeOutSpec(user.id, signerAddress, client, runInputs);
  } else {
    spec = {
      userId: user.id,
      kind,
      inputs: { wallet },
      factory: () =>
        prepareGaslessTransaction(client, {
          calls: buildApprovalCalls().map((c) => ({ to: c.to, data: c.data as `0x${string}` })),
          metadata: "HedgeFun trading approvals",
        }) as Promise<WorkflowGen>,
      autoAnswer: (r: StepRequest) => (r.kind === "requestAddress" ? signerAddress : null),
      // On-chain truth for the EXACT alpha set (S4 review B1/H2) — approvals are idempotent, so
      // definitelyNotDone can safely allow a reset even when partially landed. The predicate is
      // shared with the order path's readiness gate: it used to check four of the eight grants
      // here, which meant a run could report DONE while the wallet still could not redeem — and
      // now that the gate refuses orders on the same answer, one drifting copy would either block
      // trading forever or wave through a wallet the exchange refuses.
      verify: async () => (await isTradingReady(wallet, { force: true })).ready,
      definitelyNotDone: async () => true,
    };
  }

  // The money verbs converge on the RUN's own relayer transaction instead of a wallet-wide pUSD
  // delta (K3 S6/S7 MEDIUM-1: a concurrent fill/wrap/withdraw satisfies or masks every one of
  // them). APPROVALS keeps its live allowance check — approvals are idempotent and an external
  // revocation SHOULD re-arm the run, which is state semantics, not event semantics.
  if (kind !== "APPROVALS") spec = runScoped(spec, () => relayerVerdict(prisma, user.id, kind, client));

  try {
    const result = answer ? await answerWorkflow(prisma, spec, answer) : await startWorkflow(prisma, spec);
    if (result.status === "done") {
      if (kind === "WRAP") {
        // Nudge the watcher so the funding attempt confirms FUNDED off the pUSD delta ASAP.
        await prisma.fundingAttempt.updateMany({
          where: { userId: user.id, state: { not: "FUNDED" } },
          data: { lastCheckedAt: null },
        });
      }
      if (onDone) await onDone(); // REDEEM: consume the position so it never rebinds (K3 HIGH-1.4)
    }
    return NextResponse.json(result);
  } catch (e) {
    await captureToGlitchTip(e, { route: "real/workflow", kind });
    throw e;
  }
}

export async function GET(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isRealMoneyEligible(user)) return NextResponse.json({ error: "real_disabled" }, { status: 403 });
  if (!hasRealConsent(user)) return NextResponse.json({ error: "consent_required" }, { status: 403 });
  const rows = await prisma.walletWorkflow.findMany({
    where: { userId: user.id },
    select: { kind: true, state: true, runId: true, stepIndex: true, pendingRequestHash: true, error: true, updatedAt: true },
  });
  return NextResponse.json({ workflows: rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() })) });
}
