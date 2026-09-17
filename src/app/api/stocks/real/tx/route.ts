import { NextResponse } from "next/server";
import { authUser } from "@/lib/privy";
import { rateLimit } from "@/lib/ratelimit";
import { JupiterUnavailableError } from "@/lib/prices";
import { StockUnavailableError } from "@/lib/stocks-db";
import { HeliusUnavailableError } from "@/lib/helius";
import { buildAttempt, StockConsentRequiredError, WalletNotVerifiedError, SponsorLimitError } from "@/lib/stocks-real";
import { STOCK_MIN_STAKE_CENTS, STOCK_MAX_STAKE_CENTS } from "@/lib/config";
import type { StockRealTxRequest, StockRealTxResponse } from "@/lib/api-types";

// Build a Jupiter USDC -> xStock swap for the caller's VERIFIED wallet `payer` and record a
// StockBuyAttempt. Nothing is spent here — the client signs and sends, then /real/sent + /real/confirm.
export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!rateLimit(`stocks-real-tx:${user.id}`, 10, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as Partial<StockRealTxRequest> | null;
  const namesAsset = (typeof body?.assetId === "string" && body.assetId.length > 0) || (typeof body?.symbol === "string" && body.symbol.length > 0);
  if (
    !body ||
    !namesAsset ||
    (body.assetId !== undefined && typeof body.assetId !== "string") ||
    (body.symbol !== undefined && typeof body.symbol !== "string") ||
    typeof body.stakeCents !== "number" ||
    !Number.isInteger(body.stakeCents) ||
    body.stakeCents < STOCK_MIN_STAKE_CENTS ||
    body.stakeCents > STOCK_MAX_STAKE_CENTS ||
    typeof body.payer !== "string" ||
    (body.hedgeSuggestionId !== undefined && typeof body.hedgeSuggestionId !== "string")
  ) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const result = await buildAttempt(
      { id: user.id, stockConsentVersion: user.stockConsentVersion, privyId: user.privyId },
      {
        assetId: body.assetId || undefined,
        symbol: body.symbol || undefined,
        stakeCents: body.stakeCents,
        payer: body.payer,
        hedgeSuggestionId: body.hedgeSuggestionId,
      },
    );
    const res: StockRealTxResponse = result;
    return NextResponse.json(res);
  } catch (e) {
    if (e instanceof StockConsentRequiredError) {
      return NextResponse.json({ error: "stock_consent_required" }, { status: 403 });
    }
    if (e instanceof WalletNotVerifiedError) {
      return NextResponse.json({ error: "wallet_not_verified" }, { status: 403 });
    }
    if (e instanceof SponsorLimitError) {
      return NextResponse.json({ error: "sponsor_limit" }, { status: 429 });
    }
    if (e instanceof StockUnavailableError) {
      const status = e.message === "asset_not_found" ? 404 : 409;
      return NextResponse.json({ error: e.message }, { status });
    }
    if (e instanceof JupiterUnavailableError) {
      return NextResponse.json({ error: "swap_unavailable" }, { status: 502 });
    }
    // The sponsored build reads the chain (blockhash + lookup tables) — an RPC outage is a 502.
    if (e instanceof HeliusUnavailableError) {
      return NextResponse.json({ error: "rpc_unavailable" }, { status: 502 });
    }
    throw e;
  }
}
