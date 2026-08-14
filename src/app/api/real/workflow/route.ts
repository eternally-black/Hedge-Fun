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
import { captureToGlitchTip } from "@/lib/glitchtip";
import { serverSecureClient } from "@/lib/polymarket-server";
import { buildWrapCalls, buildApprovalCalls, CTF_EXCHANGE, NEGRISK_CTF_EXCHANGE, CONDITIONAL_TOKENS } from "@/lib/wallet-ops";
import { startWorkflow, answerWorkflow, type WorkflowGen, type WorkflowSpec, type StepRequest } from "@/lib/workflow";
import { erc20BalanceOf, erc20Allowance, erc1155IsApprovedForAll, USDCE_ADDRESS, PUSD_ADDRESS } from "@/lib/polygon";
import {
  prepareGaslessTransaction,
  prepareRedeemPositions,
  planCollateralReturn,
  prepareCollateralReturnExecution,
} from "@polymarket/client/actions";

const KINDS = ["APPROVALS", "WRAP", "REDEEM", "WITHDRAW"] as const;
type Kind = (typeof KINDS)[number];

const EVM_SIG = /^0x[0-9a-fA-F]{130}$/; // validate BEFORE the fence — the SDK throws on garbage inside it

export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasRealConsent(user)) return NextResponse.json({ error: "consent_required" }, { status: 403 });
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
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
    const bet = candidates.find((b) => (b.filledSharesMicro ?? 0n) - (b.closedSharesMicro ?? 0n) > 0n) ?? null;
    const remainder = bet ? (bet.filledSharesMicro ?? 0n) - (bet.closedSharesMicro ?? 0n) : 0n;
    const row = await prisma.walletWorkflow.findUnique({ where: { userId_kind: { userId: user.id, kind: "REDEEM" } } });
    const active = row && (row.state === "PENDING_SIGNATURE" || row.state === "SUBMITTING");
    type RedeemInputs = {
      conditionId: string;
      wallet: string;
      pusdBaseline: string;
      betId: string;
      won: boolean;
      remainderMicro: string;
    };
    // Mirror the WRAP pattern: an ACTIVE run drives on its own persisted inputs; a DONE row with
    // nothing new to redeem answers idempotent done; otherwise require a redeemable position.
    // `won`: CANCELED = push (collateral returns, converge like a win); else side === outcome
    // (executor-review fix: the generated comparison was inverted).
    const runInputs: RedeemInputs | null = active
      ? (row.inputs as RedeemInputs)
      : bet && remainder > 0n
        ? {
            conditionId: bet.market.polymarketId,
            wallet,
            pusdBaseline: (await erc20BalanceOf(PUSD_ADDRESS, wallet)).toString(),
            betId: bet.id,
            won: bet.market.status === "CANCELED" || bet.side === bet.market.resolvedOutcome,
            remainderMicro: remainder.toString(),
          }
        : row?.state === "DONE"
          ? (row.inputs as RedeemInputs)
          : null;
    if (!runInputs) return NextResponse.json({ error: "nothing_to_redeem" }, { status: 409 });
    // Consume the position on convergence (K3 HIGH-1.4): without this the same bet rebinds on
    // every poll — a fresh signature prompt and a burned relayer submission per cycle. Winners
    // book $1/share on the remainder; losers book zero; basis is fee-inclusive and prorated.
    onDone = async () => {
      const b = await prisma.bet.findUnique({ where: { id: runInputs.betId } });
      if (!b) return;
      const filled = b.filledSharesMicro ?? 0n;
      const rem = filled - (b.closedSharesMicro ?? 0n);
      if (rem <= 0n) return; // already consumed — idempotent
      const proceeds = runInputs.won ? rem : 0n; // winning shares redeem 1:1 to micro-USD
      const basis = filled > 0n ? (((b.spendMicro ?? 0n) + (b.feeMicro ?? 0n)) * rem) / filled : 0n;
      await prisma.bet.update({
        where: { id: b.id },
        data: {
          closedSharesMicro: filled,
          proceedsMicro: (b.proceedsMicro ?? 0n) + proceeds,
          realizedPnlMicro: (b.realizedPnlMicro ?? 0n) + proceeds - basis,
        },
      });
    };
    spec = {
      userId: user.id,
      kind,
      inputs: runInputs,
      factory: () =>
        prepareRedeemPositions(client, { conditionId: runInputs.conditionId } as never) as Promise<WorkflowGen>,
      autoAnswer: (r: StepRequest) => (r.kind === "requestAddress" ? signerAddress : null),
      // A win (or INVALID push) redeems to collateral — pUSD increases past the run baseline. A
      // LOSS redeems to zero: nothing to receive, converge right after submission. Loss-side
      // convergence precision is a Gate-0 refinement; alpha keeps it simple.
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
      // On-chain truth for the EXACT alpha set: pUSD allowance on both exchanges AND the ERC-1155
      // operator approval a SELL needs on both (S4 review B1/H2) — approvals are idempotent, so
      // definitelyNotDone can safely allow a reset even when partially landed.
      verify: async () => {
        const [a1, a2, o1, o2] = await Promise.all([
          erc20Allowance(PUSD_ADDRESS, wallet, CTF_EXCHANGE),
          erc20Allowance(PUSD_ADDRESS, wallet, NEGRISK_CTF_EXCHANGE),
          erc1155IsApprovedForAll(CONDITIONAL_TOKENS, wallet, CTF_EXCHANGE),
          erc1155IsApprovedForAll(CONDITIONAL_TOKENS, wallet, NEGRISK_CTF_EXCHANGE),
        ]);
        // We grant MAX — a dust allowance must not read as "approved" (Sol S4-recheck #5).
        const FLOOR = 10n ** 15n; // $1B in micro-USD: unreachable by dust, trivially met by MAX
        return a1 >= FLOOR && a2 >= FLOOR && o1 && o2;
      },
      definitelyNotDone: async () => true,
    };
  }

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
