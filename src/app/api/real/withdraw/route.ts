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
import { rateLimit } from "@/lib/ratelimit";
import { captureToGlitchTip, sendOpsTelegram } from "@/lib/glitchtip";
import { serverSecureClient } from "@/lib/polymarket-server";
import { createWithdrawal, fetchSupportedAssets, fetchWithdrawalStatus } from "@/lib/bridge";
import { bridgeOutSpec, type BridgeOutInputs } from "@/lib/bridge-out";
import { relayerVerdict } from "@/lib/relayer-verdict";
import { runScoped, startWorkflow } from "@/lib/workflow";
import { erc20BalanceOf, PUSD_ADDRESS } from "@/lib/polygon";
import { isAddress as isSolanaAddress } from "@solana/kit";

const isBridgeError = (e: unknown) => e instanceof Error && e.message.startsWith("bridge_");

export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // No eligibility gate: this is a recovery verb like EXIT/REDEEM/WITHDRAW — a flipped allowlist
  // must never be able to trap someone's money on Polygon.
  if (!hasRealConsent(user)) return NextResponse.json({ error: "consent_required" }, { status: 403 });
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  // Each POST can mint a live single-purpose forwarding address at the bridge — an unbounded loop
  // is an unbounded pile of live forwarders under our builder code that nobody is watching.
  if (!rateLimit(`real-withdraw:${user.id}`, 6, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
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

  // Address-family check, SERVER side. The browser disables its own button on a mismatch
  // (RealWithdrawCard `wrongFamily`), but that guard is one fetch away from being skipped, and the
  // bridge address it protects is single-purpose: it forwards whatever lands on it to the recipient
  // it was minted for. An EVM address accepted for a Solana withdrawal is money nobody can recover
  // on either chain. The family comes from the asset row rather than a pinned chain id — a bridge
  // tokenAddress is 0x-hex on exactly the EVM chains (bridge.ts BridgeAsset) — so a new chain in
  // the bridge's list is classified without touching this code.
  const evmFamily = /^0x[0-9a-fA-F]{40}$/.test(asset.tokenAddress);
  if (evmFamily !== /^0x[0-9a-fA-F]{40}$/.test(recipient.trim())) {
    return NextResponse.json({ error: "wrong_chain_recipient", chainName: asset.chainName }, { status: 400 });
  }
  // Solana is the only non-EVM chain the bridge serves, and base58 has no checksum — a truncated
  // paste or a one-character typo still "looks like" an address, and the forwarder it mints sends
  // money there irreversibly. Validate for real, with the validator the read-only hedge-wallet
  // link already uses; the money destination must not be the one address this codebase skips.
  if (!evmFamily && !isSolanaAddress(recipient.trim())) {
    return NextResponse.json({ error: "bad_recipient" }, { status: 400 });
  }

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

  // REUSE before minting. A bridge address is a live one-shot forwarder: it takes whatever lands on
  // it and pushes it to the recipient it was created for, so every extra one is a loose end nobody
  // is watching. The mint is an external side effect with no durable record in front of it — the
  // run's row only appears inside startWorkflow below — so a failure anywhere after it (factory
  // throw, relayer hiccup, the user simply pressing the button again) used to mint a SECOND live
  // address for the same withdrawal. A terminal run whose destination matches exactly already has
  // one, and it is still valid because nothing was ever sent to it.
  const prior = existing?.inputs as BridgeOutInputs | null;
  const reusable =
    prior?.bridgeAddress &&
    prior.chainId === chainId &&
    prior.tokenAddress === tokenAddress &&
    prior.recipient === recipient &&
    existing?.state === "FAILED"
      ? prior.bridgeAddress
      : null;

  let bridgeAddress: string;
  if (reusable) {
    bridgeAddress = reusable;
  } else {
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
    // "stale" means another request claimed the BRIDGE_OUT slot between the read at the top and
    // this call — two devices posting at once both pass that read, and both reach the mint. The
    // loser's address is live and about to belong to no run at all, which is the one outcome the
    // route's own header warns about. It cannot be un-minted and the bridge offers no lookup by
    // destination, so the only honest handling is to make sure a human learns the address instead
    // of it disappearing with the response. Nothing was sent to it, so there is no loss to recover
    // — just a forwarder to retire.
    if (result.status === "stale" && !reusable) {
      await sendOpsTelegram(
        `[withdraw] orphan bridge address ${bridgeAddress} minted for user ${user.id} ` +
          `(${chainId}/${tokenAddress} -> ${recipient}) but another run claimed the slot; nothing was sent to it`,
      ).catch(() => {});
      await captureToGlitchTip(new Error("orphan bridge address"), {
        route: "real/withdraw",
        stage: "start-stale",
        bridgeAddress,
      });
    }
    return NextResponse.json({ bridgeAddress, amountMicro: amount.toString(), ...result });
  } catch (e) {
    // Same loose end, different exit: the row may never have been written, so name the address in
    // the capture rather than leaving it only in a response nobody kept.
    await captureToGlitchTip(e, { route: "real/withdraw", stage: "start", bridgeAddress });
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
  // Autofill convenience, NOT a default to trust with money: a linked hedge wallet only proves the
  // user typed that address once, not that they control it. The EVM side is the account's own
  // signer, which is the honest default for an EVM destination. Either way the field stays editable
  // and the user confirms the destination themselves.
  const connected = {
    evm: user.embeddedWalletAddress,
    solana:
      (
        await prisma.hedgeWallet.findFirst({
          where: { userId: user.id },
          orderBy: { createdAt: "desc" },
          select: { address: true },
        })
      )?.address ?? null,
  };
  if (!row) return NextResponse.json({ workflow: null, withdrawal: null, assets, connected });

  const inputs = row.inputs as unknown as BridgeOutInputs | null;
  let status: string | null = null;
  let txHash: string | null = null;
  // Two very different things used to arrive as the same `status: null`: the bridge answering
  // "nothing has landed here yet" (an empty transactions list, which is the NORMAL state for the
  // whole window between relay submission and arrival) and the bridge not answering at all. The
  // card rendered both as "status unavailable", so the healthy majority of a withdrawal's life
  // read as an outage. `statusRead` separates them.
  let statusRead = false;
  if (inputs?.bridgeAddress) {
    try {
      ({ status, txHash } = await fetchWithdrawalStatus(inputs.bridgeAddress));
      statusRead = true;
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
          statusRead,
          txHash,
        }
      : null,
    assets,
    connected,
  });
}
