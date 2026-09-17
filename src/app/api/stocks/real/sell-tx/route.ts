import { NextResponse } from "next/server";
import { authUser } from "@/lib/privy";
import { rateLimit } from "@/lib/ratelimit";
import { JupiterUnavailableError } from "@/lib/prices";
import { HeliusUnavailableError } from "@/lib/helius";
import { SponsorUnavailableError } from "@/lib/sponsor";
import { StockUnavailableError } from "@/lib/stocks-db";
import {
  buildSellAttempt,
  StockConsentRequiredError,
  WalletNotVerifiedError,
  SponsorLimitError,
} from "@/lib/stocks-real";
import type { StockRealSellTxRequest, StockRealSellTxResponse } from "@/lib/api-types";

// Build a fee-sponsored xStock -> USDC swap that sells ONE open REAL lot in full. Nothing is sold
// here: the wallet signs, /real/submit sends, /real/confirm closes the lot from the landed tx.
export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!rateLimit(`stocks-real-sell-tx:${user.id}`, 10, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as Partial<StockRealSellTxRequest> | null;
  if (!body || typeof body.positionId !== "string" || !body.positionId) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const res: StockRealSellTxResponse = await buildSellAttempt(
      { id: user.id, stockConsentVersion: user.stockConsentVersion, privyId: user.privyId },
      body.positionId,
    );
    return NextResponse.json(res);
  } catch (e) {
    if (e instanceof StockConsentRequiredError) {
      return NextResponse.json({ error: "stock_consent_required" }, { status: 403 });
    }
    if (e instanceof WalletNotVerifiedError) {
      return NextResponse.json({ error: "wallet_not_verified" }, { status: 403 });
    }
    if (e instanceof SponsorUnavailableError) {
      return NextResponse.json({ error: "sponsor_unavailable" }, { status: 409 });
    }
    if (e instanceof SponsorLimitError) {
      return NextResponse.json({ error: "sponsor_limit" }, { status: 429 });
    }
    if (e instanceof StockUnavailableError) {
      const status = e.message === "position_not_found" ? 404 : 409;
      return NextResponse.json({ error: e.message }, { status });
    }
    if (e instanceof JupiterUnavailableError) {
      return NextResponse.json({ error: "swap_unavailable" }, { status: 502 });
    }
    if (e instanceof HeliusUnavailableError) {
      return NextResponse.json({ error: "rpc_unavailable" }, { status: 502 });
    }
    throw e;
  }
}
