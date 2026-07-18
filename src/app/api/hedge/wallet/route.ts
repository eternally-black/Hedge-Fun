import { NextResponse } from "next/server";
import { isAddress } from "@solana/kit";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
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

// Shape a snapshot into the wire exposure summary (shared by POST link and GET returning-user state).
function toWalletResponse(address: string, snap: SnapshotData): HedgeWalletResponse {
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
    select: { address: true },
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
  const res: HedgeWalletStateResponse = { walletLinked: true, exposure: toWalletResponse(address, snap), stale };
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

  // Link the address (idempotent — one row per user+address).
  await prisma.hedgeWallet.upsert({
    where: { userId_address: { userId: user.id, address } },
    create: { userId: user.id, address },
    update: {},
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

  const res: HedgeWalletResponse = toWalletResponse(address, snap);
  return NextResponse.json(res);
}
