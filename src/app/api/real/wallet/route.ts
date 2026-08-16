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
import { isRealMoneyEligible, hasRealConsent, sameOrigin } from "@/lib/real";
import { captureToGlitchTip } from "@/lib/glitchtip";
import { contractOwner, erc20BalanceOf, PUSD_ADDRESS } from "@/lib/polygon";
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
  // Inner gate (§2.7): explicit persisted opt-in. Until the step-8 consent UI exists, the owner
  // flips their own realConsentAt row by hand — fail-closed beats convenient.
  if (!hasRealConsent(user)) {
    return NextResponse.json({ error: "consent_required" }, { status: 403 });
  }
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });

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

// GET /api/real/wallet — the real-money console's single status read. Without it the browser can
// only infer eligibility/consent/provisioning from 403s on other routes, which is guesswork.
export async function GET(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Spendable balance, read from chain — the CLOB counts pUSD and nothing else, so this is the
  // number the real-money HUD shows where paper shows Cash. Only read when a deposit wallet exists
  // (nothing to ask about otherwise) and never fatal: an RPC hiccup returns null so the caller can
  // render "—" instead of failing the whole screen. It lives here rather than on /api/me because
  // that endpoint is fetched on every screen and must not carry an RPC round-trip.
  let pusdMicro: string | null = null;
  if (user.depositWalletAddress) {
    pusdMicro = await erc20BalanceOf(PUSD_ADDRESS, user.depositWalletAddress)
      .then((v) => v.toString())
      .catch(() => null);
  }

  // Deliberately ungated: this read is what TELLS the client whether consent exists, and it exposes
  // nothing about the account the user cannot already see.
  return NextResponse.json(
    {
      eligible: isRealMoneyEligible(user),
      consented: hasRealConsent(user),
      embeddedWalletAddress: user.embeddedWalletAddress ?? null,
      depositWalletAddress: user.depositWalletAddress ?? null,
      pusdMicro,
    },
    // A stale provisioning state would render a "Provision wallet" button for a wallet that exists.
    { headers: { "Cache-Control": "no-store" } },
  );
}
