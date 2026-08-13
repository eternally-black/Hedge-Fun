// POST /api/real/workflow — the device-facing end of the durable signature relay (plan §2.4).
// Body: { kind: "APPROVALS" | "WRAP", answer?: { requestHash, signature } }.
// No answer → start-or-resume: returns the pending signature request (same payload on retry).
// With answer → advance. SUBMITTING rows converge from chain state here, never re-drive.
// GET — current workflow states for the funding screen.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import { isRealMoneyEligible, hasRealConsent } from "@/lib/real";
import { captureToGlitchTip } from "@/lib/glitchtip";
import { serverSecureClient } from "@/lib/polymarket-server";
import { buildWrapCalls } from "@/lib/wallet-ops";
import { driveWorkflow, completeWorkflow, type WorkflowGen, type StepRequest } from "@/lib/workflow";
import { erc20BalanceOf, USDCE_ADDRESS } from "@/lib/polygon";
import { prepareGaslessTransaction, prepareTradingApprovals, fetchBalanceAllowance } from "@polymarket/client/actions";

const KINDS = ["APPROVALS", "WRAP"] as const;
type Kind = (typeof KINDS)[number];

export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isRealMoneyEligible(user)) return NextResponse.json({ error: "real_disabled" }, { status: 403 });
  if (!hasRealConsent(user)) return NextResponse.json({ error: "consent_required" }, { status: 403 });
  const wallet = user.depositWalletAddress;
  const signerAddress = user.embeddedWalletAddress;
  if (!wallet || !signerAddress) return NextResponse.json({ error: "no_deposit_wallet" }, { status: 409 });

  let kind: Kind;
  let answer: { requestHash: string; signature: string } | undefined;
  try {
    const body = await req.json();
    if (!KINDS.includes(body?.kind)) return NextResponse.json({ error: "bad_kind" }, { status: 400 });
    kind = body.kind;
    if (body.answer) {
      if (typeof body.answer.requestHash !== "string" || typeof body.answer.signature !== "string") {
        return NextResponse.json({ error: "bad_answer" }, { status: 400 });
      }
      answer = { requestHash: body.answer.requestHash, signature: body.answer.signature };
    }
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const client = await serverSecureClient(prisma, user);
  if (!client) return NextResponse.json({ error: "real_not_configured" }, { status: 503 });

  // Deterministic immutable inputs per run (the generator is rebuilt from these on every call).
  let inputs: Record<string, string>;
  let factory: () => Promise<WorkflowGen>;
  if (kind === "WRAP") {
    // Amount pins to the watcher-observed FINALIZED balance of the active DETECTED attempt —
    // stable across rebuilds, exact-approval rule (§6.1), nothing to wrap without one.
    const attempt = await prisma.fundingAttempt.findFirst({
      where: { userId: user.id, state: "DETECTED" },
      orderBy: { declaredAt: "desc" },
    });
    if (!attempt || attempt.latestUsdceMicro <= 0n) {
      return NextResponse.json({ error: "nothing_to_wrap" }, { status: 409 });
    }
    const amountMicro = attempt.latestUsdceMicro;
    inputs = { wallet, amountMicro: amountMicro.toString() };
    factory = () =>
      prepareGaslessTransaction(client, {
        calls: buildWrapCalls(wallet, amountMicro).map((c) => ({ to: c.to, data: c.data as `0x${string}` })),
        metadata: "HedgeFun wrap USDC.e -> pUSD",
      }) as Promise<WorkflowGen>;
  } else {
    inputs = { wallet };
    factory = () => prepareTradingApprovals(client) as Promise<WorkflowGen>;
  }

  const result = await driveWorkflow(prisma, {
    userId: user.id,
    kind,
    inputs,
    factory,
    // requestAddress is answerable server-side (an address, not a signature) — deterministic.
    autoAnswer: (r: StepRequest) => (r.kind === "requestAddress" ? signerAddress : null),
    answer,
  });

  // SUBMITTING → chain-state convergence (never blind resubmit).
  if (result.status === "submitting") {
    try {
      if (kind === "WRAP") {
        const usdce = await erc20BalanceOf(USDCE_ADDRESS, wallet);
        if (usdce < BigInt(inputs.amountMicro)) {
          await completeWorkflow(prisma, user.id, kind, { ok: true });
          // Nudge the watcher so the funding attempt confirms FUNDED off the pUSD delta ASAP.
          await prisma.fundingAttempt.updateMany({
            where: { userId: user.id, state: { not: "FUNDED" } },
            data: { lastCheckedAt: null },
          });
          return NextResponse.json({ status: "done" });
        }
      } else {
        const allowance = await fetchBalanceAllowance(client, { assetType: "COLLATERAL" } as never);
        const value = (allowance as { allowance?: bigint })?.allowance ?? 0n;
        if (value > 0n) {
          await completeWorkflow(prisma, user.id, kind, { ok: true });
          return NextResponse.json({ status: "done" });
        }
      }
    } catch (e) {
      await captureToGlitchTip(e, { route: "real/workflow", stage: "converge", kind });
    }
  }

  return NextResponse.json(result);
}

export async function GET(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isRealMoneyEligible(user)) return NextResponse.json({ error: "real_disabled" }, { status: 403 });
  const rows = await prisma.walletWorkflow.findMany({
    where: { userId: user.id },
    select: { kind: true, state: true, stepIndex: true, pendingRequestHash: true, error: true, updatedAt: true },
  });
  return NextResponse.json({ workflows: rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() })) });
}
