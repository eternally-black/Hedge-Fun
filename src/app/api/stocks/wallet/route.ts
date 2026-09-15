import { NextResponse } from "next/server";
import { authUser } from "@/lib/privy";
import { rateLimit } from "@/lib/ratelimit";
import { HeliusUnavailableError, getBalanceLamports, getTokenBalanceRaw } from "@/lib/helius";
import { USDC_MINT, usdcMicroToCentsFloor } from "@/lib/stocks";
import { verifiedWallets } from "@/lib/stocks-db";
import { sponsorConfigured } from "@/lib/sponsor";
import type { StockWalletResponse } from "@/lib/api-types";

// Live balances of ONE of the caller's VERIFIED wallets — the "fund your wallet" panel. Only a
// verified wallet, so this can never be used to snoop on an arbitrary address through our RPC key.
export async function GET(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!rateLimit(`stocks-wallet:${user.id}`, 60, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const address = new URL(req.url).searchParams.get("address");
  if (!address) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const wallets = await verifiedWallets(user.id);
  if (!wallets.includes(address)) {
    return NextResponse.json({ error: "wallet_not_verified" }, { status: 403 });
  }

  try {
    const [usdcMicro, lamports] = await Promise.all([
      getTokenBalanceRaw(address, USDC_MINT),
      getBalanceLamports(address),
    ]);
    const body: StockWalletResponse = {
      address,
      // FLOOR: a "you have $X" panel must never promise a cent the wallet cannot spend.
      usdcCents: usdcMicroToCentsFloor(usdcMicro),
      solLamports: String(lamports),
      sponsored: sponsorConfigured(),
    };
    return NextResponse.json(body);
  } catch (e) {
    if (e instanceof HeliusUnavailableError) {
      return NextResponse.json({ error: "rpc_unavailable" }, { status: 502 });
    }
    throw e;
  }
}
