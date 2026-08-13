// POST /api/real/wallet — the browser reports its SDK-deployed Deposit Wallet; the server verifies
// and persists idempotently. The server does NOT hold a signer (D5 — deploy happens in the browser
// via createSecureClient); signer↔wallet derivation binding is validated at order time, not here.
// This route only verifies the wallet is deployed on-chain and records it as the user's deposit
// wallet + a RelayerTx ledger entry (the deploy already went through the relayer client-side).
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { authUser, syncEmbeddedWallet, isEvmAddress } from "@/lib/privy";
import { isRealMoneyEligible } from "@/lib/real";
import { polymarketPublic } from "@/lib/polymarket-sdk";
// Low-level actions live in the /actions subpath, not the root (same trap as fetchBalanceAllowance).
import { isWalletDeployed } from "@polymarket/client/actions";
import { WalletType } from "@polymarket/bindings/gamma";

export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!isRealMoneyEligible(user)) {
    return NextResponse.json({ error: "real_disabled" }, { status: 403 });
  }

  let embeddedWallet: string | null;
  try {
    embeddedWallet = await syncEmbeddedWallet(user);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return NextResponse.json({ error: "wallet_conflict" }, { status: 409 });
    }
    throw e;
  }
  if (!embeddedWallet) {
    return NextResponse.json({ error: "no_embedded_wallet" }, { status: 409 });
  }

  let depositWalletAddress: string | undefined;
  try {
    const body = await req.json();
    depositWalletAddress = body?.depositWalletAddress;
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const address = (depositWalletAddress ?? "").toLowerCase();
  if (!isEvmAddress(address)) {
    return NextResponse.json({ error: "bad_address" }, { status: 400 });
  }

  // Idempotent: if already persisted, only accept the same address — never silently overwrite.
  if (user.depositWalletAddress) {
    if (user.depositWalletAddress === address) {
      return NextResponse.json({ depositWalletAddress: address });
    }
    return NextResponse.json({ error: "wallet_mismatch" }, { status: 409 });
  }

  // Verify on-chain deployment (credential-free public client).
  let deployed: boolean;
  try {
    deployed = await isWalletDeployed(polymarketPublic, { wallet: address, type: WalletType.DEPOSIT_WALLET });
  } catch {
    return NextResponse.json({ error: "chain_check_unavailable" }, { status: 503 });
  }
  if (!deployed) {
    return NextResponse.json({ error: "not_deployed" }, { status: 409 });
  }

  // Persist in one transaction: set the deposit wallet + record the relayer ledger entry.
  try {
    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { depositWalletAddress: address },
      }),
      prisma.relayerTx.upsert({
        where: {
          userId_kind_workflowKey: {
            userId: user.id,
            kind: "DEPLOY",
            workflowKey: address,
          },
        },
        create: {
          userId: user.id,
          kind: "DEPLOY",
          workflowKey: address,
          status: "CONFIRMED",
        },
        update: {
          attempts: { increment: 1 },
          status: "CONFIRMED",
        },
      }),
    ]);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return NextResponse.json({ error: "wallet_taken" }, { status: 409 });
    }
    throw e;
  }

  return NextResponse.json({ depositWalletAddress: address });
}
