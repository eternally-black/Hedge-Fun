// POST /api/real/wallet — the browser reports its SDK-deployed Deposit Wallet; the server verifies
// and persists idempotently. The server does NOT hold a signer (D5 — deploy happens in the browser
// via createSecureClient). Ownership is BOUND HERE, before any funding can flow (Sol's step-2
// blocker): the claimed wallet's on-chain owner() must equal the authenticated user's embedded
// wallet — one eth_call, no derivation, no extra signature. The RelayerTx row is an OBSERVED
// deployment (lower-bound budget ledger); true intent-first accounting starts with the
// server-driven ops in step 4.
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { authUser, syncEmbeddedWallet, isEvmAddress } from "@/lib/privy";
import { isRealMoneyEligible, hasRealConsent } from "@/lib/real";
import { captureToGlitchTip } from "@/lib/glitchtip";
import { polymarketPublic } from "@/lib/polymarket-sdk";
import { contractOwner } from "@/lib/polygon";
// Low-level actions live in the /actions subpath, not the root (same trap as fetchBalanceAllowance).
import { isWalletDeployed } from "@polymarket/client/actions";
import { WalletType } from "@polymarket/bindings/gamma";

export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!isRealMoneyEligible(user)) {
    return NextResponse.json({ error: "real_disabled" }, { status: 403 });
  }
  // Inner gate (§2.7): explicit persisted opt-in. Until the step-8 consent UI exists, the owner
  // flips their own realConsentAt row by hand — fail-closed beats convenient.
  if (!hasRealConsent(user)) {
    return NextResponse.json({ error: "consent_required" }, { status: 403 });
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

  let depositWalletAddress: unknown;
  try {
    const body = await req.json();
    depositWalletAddress = body?.depositWalletAddress;
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  if (typeof depositWalletAddress !== "string") {
    return NextResponse.json({ error: "bad_address" }, { status: 400 });
  }
  const address = depositWalletAddress.toLowerCase();
  if (!isEvmAddress(address)) {
    return NextResponse.json({ error: "bad_address" }, { status: 400 });
  }

  // Different address than the persisted one is a hard 409 — never silently overwrite. The
  // SAME-address early return deliberately comes AFTER the binding check below (K3): a row
  // persisted by the pre-binding route version must not keep validating by its mere existence.
  if (user.depositWalletAddress && user.depositWalletAddress !== address) {
    return NextResponse.json({ error: "wallet_mismatch" }, { status: 409 });
  }

  // Verify on-chain deployment (credential-free public client), then BIND ownership: the wallet's
  // owner() must be the authenticated user's embedded signer. Without this, a compromised client
  // could persist an attacker's deployed wallet and step-3 deposits would flow to it.
  let deployed: boolean;
  let owner: string;
  try {
    deployed = await isWalletDeployed(polymarketPublic, { wallet: address, type: WalletType.DEPOSIT_WALLET });
    owner = deployed ? await contractOwner(address) : "";
  } catch (e) {
    await captureToGlitchTip(e, { route: "real/wallet", stage: "chain-check" });
    return NextResponse.json({ error: "chain_check_unavailable" }, { status: 503 });
  }
  if (!deployed) {
    return NextResponse.json({ error: "not_deployed" }, { status: 409 });
  }
  if (owner !== embeddedWallet) {
    return NextResponse.json({ error: "not_your_wallet" }, { status: 403 });
  }

  if (user.depositWalletAddress === address) {
    return NextResponse.json({ depositWalletAddress: address }); // idempotent re-report, re-validated
  }

  // Persist with an atomic compare-and-set on depositWalletAddress IS NULL — a concurrent second
  // device cannot silently replace an already-persisted money destination (Sol finding #2). The
  // CAS and the ledger row commit together: a crash between them must not drop the observation.
  try {
    const persisted = await prisma.$transaction(async (tx) => {
      const claimed = await tx.user.updateMany({
        where: { id: user.id, depositWalletAddress: null },
        data: { depositWalletAddress: address },
      });
      if (claimed.count === 0) return false;
      // Observed-deployment ledger row (NOT submission accounting — the deploy ran client-side).
      await tx.relayerTx.upsert({
        where: { userId_kind_workflowKey: { userId: user.id, kind: "DEPLOY", workflowKey: address } },
        create: { userId: user.id, kind: "DEPLOY", workflowKey: address, status: "CONFIRMED" },
        update: {},
      });
      return true;
    });
    if (!persisted) {
      const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { depositWalletAddress: true } });
      if (fresh.depositWalletAddress === address) {
        return NextResponse.json({ depositWalletAddress: address });
      }
      return NextResponse.json({ error: "wallet_mismatch" }, { status: 409 });
    }
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return NextResponse.json({ error: "wallet_taken" }, { status: 409 });
    }
    throw e;
  }

  return NextResponse.json({ depositWalletAddress: address });
}
