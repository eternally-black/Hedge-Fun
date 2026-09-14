import { NextResponse } from "next/server";
import { authUser } from "@/lib/privy";
import { rateLimit } from "@/lib/ratelimit";
import { InsufficientFundsError } from "@/lib/swipe";
import { buyStockPaper, StockUnavailableError, StockPriceUnavailableError } from "@/lib/stocks-db";
import { STOCK_MIN_STAKE_CENTS, STOCK_MAX_STAKE_CENTS } from "@/lib/config";
import type { StockBuyRequest, StockBuyResponse } from "@/lib/api-types";

// PAPER buy: locks the live price server-side, holds stakeCents against Cash (atomic, like a swipe).
// requestId (client uuid) makes a retry return the same lot (alreadyBought:true).
export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!rateLimit(`stocks-buy:${user.id}`, 30, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as Partial<StockBuyRequest> | null;
  if (
    !body ||
    typeof body.assetId !== "string" ||
    body.assetId.length === 0 ||
    typeof body.stakeCents !== "number" ||
    !Number.isInteger(body.stakeCents) ||
    body.stakeCents < STOCK_MIN_STAKE_CENTS ||
    body.stakeCents > STOCK_MAX_STAKE_CENTS ||
    typeof body.requestId !== "string" ||
    !/^[0-9a-f-]{8,64}$/i.test(body.requestId)
  ) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const result = await buyStockPaper(user.id, body.assetId, body.stakeCents, "DECK", { requestId: body.requestId });
    const res: StockBuyResponse = result;
    return NextResponse.json(res);
  } catch (e) {
    if (e instanceof StockUnavailableError) {
      const status = e.message === "asset_not_found" ? 404 : 409;
      return NextResponse.json({ error: e.message }, { status });
    }
    if (e instanceof InsufficientFundsError) {
      return NextResponse.json({ error: "insufficient_funds" }, { status: 402 });
    }
    if (e instanceof StockPriceUnavailableError) {
      return NextResponse.json({ error: "price_unavailable" }, { status: 502 });
    }
    throw e;
  }
}
