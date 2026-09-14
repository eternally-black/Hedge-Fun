import { NextResponse } from "next/server";
import { authUser } from "@/lib/privy";
import { rateLimit } from "@/lib/ratelimit";
import { sellStockPaper, StockUnavailableError, StockPriceUnavailableError } from "@/lib/stocks-db";
import type { StockSellRequest, StockSellResponse } from "@/lib/api-types";

// PAPER sell: closes the lot at the live price, credits P&L, releases the hold.
export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!rateLimit(`stocks-sell:${user.id}`, 30, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as Partial<StockSellRequest> | null;
  if (!body || typeof body.positionId !== "string" || body.positionId.length === 0) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const result = await sellStockPaper(user.id, body.positionId);
    const res: StockSellResponse = result;
    return NextResponse.json(res);
  } catch (e) {
    if (e instanceof StockUnavailableError) {
      const status = e.message === "position_not_found" ? 404 : 409;
      return NextResponse.json({ error: e.message }, { status });
    }
    if (e instanceof StockPriceUnavailableError) {
      return NextResponse.json({ error: "price_unavailable" }, { status: 502 });
    }
    throw e;
  }
}
