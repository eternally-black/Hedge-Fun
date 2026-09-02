import { NextResponse } from "next/server";
import { isAddress } from "@solana/kit";
import { prisma } from "@/lib/prisma";
import { authUser, getPrivyUser, linkedSolanaWallets } from "@/lib/privy";
import { rateLimit } from "@/lib/ratelimit";
import { getSnapshot, getCachedSnapshot, type SnapshotData } from "@/lib/hedge/snapshot";
import { HeliusUnavailableError } from "@/lib/helius";
import { JupiterUnavailableError } from "@/lib/prices";
import { WSOL_MINT } from "@/lib/hedge/exposure";
import { WALLET_SNAPSHOT_TTL_MS } from "@/lib/config";
import type {
  HedgeWalletRequest,
  HedgeWalletResponse,
  HedgeWalletStateResponse,
  HedgeExposureAsset,
} from "@/lib/api-types";

// Privy is asked on every link whether the address is one the user connected through it; a hanging
// Privy must not hold the link POST — 3 s is well past its normal answer.
const PRIVY_TIMEOUT_MS = 3_000;

// Shape a snapshot into the wire exposure summary (shared by POST link and GET returning-user state).
function toWalletResponse(address: string, snap: SnapshotData, verified: boolean): HedgeWalletResponse {
  const majors: HedgeExposureAsset[] = snap.exposure.majors.map((a) => {
    const mint = a.asset === "SOL" ? WSOL_MINT : a.mint;
    const avgBuyCostCents = mint && snap.avgCost ? snap.avgCost[mint] ?? null : null;
    return {
      asset: a.asset,
      mint: a.mint,
      amount: String(a.amount),
      notionalCents: a.notionalCents,
      isMajor: true,
      avgBuyCostCents,
    };
  });
  return {
    address,
    verified,
    totalNotionalCents: snap.totalNotionalCents,
    majors,
    splAggregateCents: snap.exposure.splAggregateCents,
    snapshotFetchedAt: snap.fetchedAt.toISOString(),
    pnlAvailable: snap.pnlAvailable,
  };
}

// Returning-user state (F18a): linked-wallet status + the CACHED exposure of the primary wallet. Reads
// ONLY the cached snapshot (never a Helius/Jupiter/Birdeye call), so a returning user's exposure panel
// paints instantly without re-pasting an address; the deterministic suggestions come from GET
// /api/hedge/suggestions as before. `stale` flags a missing or past-TTL cache so the client can offer
// a refresh, but the panel still renders. The paste form stays reachable in every branch.
export async function GET(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!rateLimit(`hedge-wallet-get:${user.id}`, 60, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  // Primary wallet = the most recently linked one (that's the address the exposure panel represents).
  const wallets = await prisma.hedgeWallet.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    select: { address: true, verifiedAt: true },
  });
  if (wallets.length === 0) {
    const res: HedgeWalletStateResponse = { walletLinked: false, exposure: null, stale: false };
    return NextResponse.json(res);
  }

  const address = wallets[0].address;
  const snap = await getCachedSnapshot(address); // cache-only: NO external calls
  if (!snap) {
    // Linked but never snapshotted (or the cache row is gone) — no cached exposure to show yet.
    const res: HedgeWalletStateResponse = { walletLinked: true, exposure: null, stale: true };
    return NextResponse.json(res);
  }
  const stale = Date.now() - snap.fetchedAt.getTime() >= WALLET_SNAPSHOT_TTL_MS;
  const res: HedgeWalletStateResponse = {
    walletLinked: true,
    exposure: toWalletResponse(address, snap, wallets[0].verifiedAt !== null),
    stale,
  };
  return NextResponse.json(res);
}

// Link a read-only Solana address (keys are NEVER requested) and return its exposure summary.
// Builds/refreshes the TTL-cached WalletSnapshot (Helius balances × Jupiter prices + Birdeye cost).
export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Guards the external-call path (Helius/Jupiter/Birdeye) before it touches the network.
  if (!rateLimit(`hedge-wallet:${user.id}`, 12, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as Partial<HedgeWalletRequest> | null;
  const address = (body?.address ?? "").trim();
  if (!address || !isAddress(address)) {
    return NextResponse.json({ error: "valid base58 Solana address required" }, { status: 400 });
  }

  // Ownership: an address the user LINKED through Privy (Phantom etc. signed Privy's challenge) is
  // proven; a pasted one is only typed. Read-only hedging works either way — the flag decides what
  // the withdraw form may offer as a money destination. A Privy outage — throwing OR hanging, hence
  // the race — leaves this link unverified, never unlinked; a later re-link re-checks. The timer is
  // cleared on the way out so the losing promise never becomes an unhandled rejection.
  let verified = false;
  let privyTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pu = await Promise.race([
      getPrivyUser(user.privyId),
      new Promise<never>((_, reject) => {
        privyTimer = setTimeout(() => reject(new Error("privy timeout")), PRIVY_TIMEOUT_MS);
      }),
    ]);
    verified = linkedSolanaWallets(pu).includes(address);
  } catch {
    verified = false;
  } finally {
    clearTimeout(privyTimer);
  }

  // Link the address (idempotent — one row per user+address). Verification only ever ratchets up:
  // a re-paste of an address Privy no longer lists keeps the earlier proof — which is why the
  // response reports the STORED flag, not this request's check.
  const linked = await prisma.hedgeWallet.upsert({
    where: { userId_address: { userId: user.id, address } },
    create: { userId: user.id, address, verifiedAt: verified ? new Date() : null },
    update: verified ? { verifiedAt: new Date() } : {},
    select: { verifiedAt: true },
  });

  let snap;
  try {
    snap = await getSnapshot(address);
  } catch (e) {
    // No balances (Helius) or no prices (Jupiter) -> no exposure to render. Both map to the same
    // typed 502 (exposure_unavailable); Birdeye failures degrade inside getSnapshot (never here). The
    // prior WalletSnapshot row survives untouched (upsert never ran), so a repeat call can still serve
    // the stale cache once upstream recovers.
    if (e instanceof HeliusUnavailableError || e instanceof JupiterUnavailableError) {
      return NextResponse.json({ error: "exposure_unavailable" }, { status: 502 });
    }
    throw e;
  }

  const res: HedgeWalletResponse = toWalletResponse(address, snap, linked.verifiedAt !== null);
  return NextResponse.json(res);
}
