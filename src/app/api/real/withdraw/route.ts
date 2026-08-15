// POST /api/real/withdraw — the money-out leg: create a single-purpose bridge address for the
// user's chosen chain/token/recipient, then start the relay run that transfers pUSD to it.
// This route is the ONLY place allowed to mint that address; /api/real/workflow drives the run
// afterwards. A retry that minted a fresh address would leave live one-shot forwarding addresses
// behind, which the bridge's own docs warn against.
// Note this is the second half of the funds-out story: WITHDRAW (collateral return) turns positions
// back into pUSD inside the wallet, BRIDGE_OUT is what actually leaves Polygon.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import { hasRealConsent, sameOrigin } from "@/lib/real";
import { captureToGlitchTip } from "@/lib/glitchtip";
import { serverSecureClient } from "@/lib/polymarket-server";
import { createWithdrawal, fetchSupportedAssets, fetchWithdrawalStatus } from "@/lib/bridge";
import { bridgeOutSpec, type BridgeOutInputs } from "@/lib/bridge-out";
import { relayerVerdict } from "@/lib/relayer-verdict";
import { runScoped, startWorkflow } from "@/lib/workflow";
import { erc20BalanceOf, PUSD_ADDRESS } from "@/lib/polygon";

const isBridgeError = (e: unknown) => e instanceof Error && e.message.startsWith("bridge_");

export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // No eligibility gate: this is a recovery verb like EXIT/REDEEM/WITHDRAW — a flipped allowlist
  // must never be able to trap someone's money on Polygon.
  if (!hasRealConsent(user)) return NextResponse.json({ error: "consent_required" }, { status: 403 });
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const wallet = user.depositWalletAddress;
  const signerAddress = user.embeddedWalletAddress;
  if (!wallet || !signerAddress) return NextResponse.json({ error: "no_deposit_wallet" }, { status: 409 });

  let chainId: unknown, tokenAddress: unknown, recipient: unknown, amountMicro: unknown;
  try {
    ({ chainId, tokenAddress, recipient, amountMicro } = await req.json());
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  if (typeof chainId !== "string" || typeof tokenAddress !== "string" || typeof recipient !== "string") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  // Recipient formats differ per chain (a Solana base58 mint address is not 0x-hex), so the only
  // honest local check is shape-agnostic — the bridge validates it for real.
  if (recipient.trim().length < 1 || recipient.length > 128 || /\s/.test(recipient)) {
    return NextResponse.json({ error: "bad_recipient" }, { status: 400 });
  }
  if (amountMicro !== undefined && (typeof amountMicro !== "string" || !/^\d+$/.test(amountMicro))) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const client = await serverSecureClient(prisma, user);
  if (!client) return NextResponse.json({ error: "real_not_configured" }, { status: 503 });

  let asset;
  try {
    asset = (await fetchSupportedAssets()).find((a) => a.chainId === chainId && a.tokenAddress === tokenAddress);
  } catch (e) {
    if (isBridgeError(e)) return NextResponse.json({ error: "bridge_unavailable" }, { status: 502 });
    throw e;
  }
  if (!asset) return NextResponse.json({ error: "unsupported_asset" }, { status: 400 });

  const pusd = await erc20BalanceOf(PUSD_ADDRESS, wallet);
  let amount = pusd;
  if (typeof amountMicro === "string") {
    amount = BigInt(amountMicro);
    if (amount <= 0n) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    if (amount > pusd) return NextResponse.json({ error: "insufficient_balance" }, { status: 409 });
  }
  // The minimum belongs to the BRIDGE, not to us: below it the transfer still leaves the wallet
  // and simply sits at the bridge address, so refusing here is the difference between a rejected
  // request and stranded money.
  const minMicro = BigInt(Math.round(asset.minUsd * 1_000_000));
  if (amount < minMicro) {
    return NextResponse.json({ error: "below_minimum", minUsd: asset.minUsd }, { status: 409 });
  }

  const existing = await prisma.walletWorkflow.findUnique({
    where: { userId_kind: { userId: user.id, kind: "BRIDGE_OUT" } },
  });
  if (existing && (existing.state === "PENDING_SIGNATURE" || existing.state === "SUBMITTING")) {
    return NextResponse.json({ error: "withdrawal_in_flight" }, { status: 409 });
  }

  let bridgeAddress: string;
  try {
    ({ evmAddress: bridgeAddress } = await createWithdrawal({
      wallet,
      toChainId: chainId,
      toTokenAddress: tokenAddress,
      recipientAddr: recipient,
    }));
  } catch (e) {
    await captureToGlitchTip(e, { route: "real/withdraw", stage: "bridge-create" });
    if (isBridgeError(e)) return NextResponse.json({ error: "bridge_unavailable" }, { status: 502 });
    throw e;
  }

  const inputs: BridgeOutInputs = {
    bridgeAddress,
    recipient,
    chainId,
    tokenAddress,
    amountMicro: amount.toString(),
    wallet,
    pusdBaseline: pusd.toString(),
  };
  const spec = runScoped(bridgeOutSpec(user.id, signerAddress, client, inputs), () =>
    relayerVerdict(prisma, user.id, "BRIDGE_OUT", client),
  );

  try {
    const result = await startWorkflow(prisma, spec);
    return NextResponse.json({ bridgeAddress, amountMicro: amount.toString(), ...result });
  } catch (e) {
    await captureToGlitchTip(e, { route: "real/withdraw", stage: "start" });
    throw e;
  }
}

export async function GET(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasRealConsent(user)) return NextResponse.json({ error: "consent_required" }, { status: 403 });

  const row = await prisma.walletWorkflow.findUnique({
    where: { userId_kind: { userId: user.id, kind: "BRIDGE_OUT" } },
  });
  // The asset list rides along so the browser needs no second endpoint; a bridge outage degrades
  // it to an empty list rather than failing the read.
  const assets = await fetchSupportedAssets().catch(() => []);
  if (!row) return NextResponse.json({ workflow: null, withdrawal: null, assets });

  const inputs = row.inputs as unknown as BridgeOutInputs | null;
  let status: string | null = null;
  let txHash: string | null = null;
  if (inputs?.bridgeAddress) {
    try {
      ({ status, txHash } = await fetchWithdrawalStatus(inputs.bridgeAddress));
    } catch {
      // A status outage must not hide the row: the destination and the amount are exactly what the
      // operator needs to see while the bridge is unreachable.
    }
  }

  return NextResponse.json({
    workflow: {
      kind: row.kind,
      state: row.state,
      stepIndex: row.stepIndex,
      error: row.error,
      updatedAt: row.updatedAt.toISOString(),
    },
    withdrawal: inputs?.bridgeAddress
      ? {
          bridgeAddress: inputs.bridgeAddress,
          recipient: inputs.recipient,
          chainId: inputs.chainId,
          tokenAddress: inputs.tokenAddress,
          amountMicro: inputs.amountMicro,
          status,
          txHash,
        }
      : null,
    assets,
  });
}
