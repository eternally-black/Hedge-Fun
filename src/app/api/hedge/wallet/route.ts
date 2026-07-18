import { NextResponse } from "next/server";
import { isAddress } from "@solana/kit";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import { rateLimit } from "@/lib/ratelimit";
import { getSnapshot } from "@/lib/hedge/snapshot";
import { HeliusUnavailableError } from "@/lib/helius";
import { JupiterUnavailableError } from "@/lib/prices";
import { WSOL_MINT } from "@/lib/hedge/exposure";
import type { HedgeWalletRequest, HedgeWalletResponse, HedgeExposureAsset } from "@/lib/api-types";

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

  const res: HedgeWalletResponse = {
    address,
    totalNotionalCents: snap.totalNotionalCents,
    majors,
    splAggregateCents: snap.exposure.splAggregateCents,
    snapshotFetchedAt: snap.fetchedAt.toISOString(),
    pnlAvailable: snap.pnlAvailable,
  };
  return NextResponse.json(res);
}
