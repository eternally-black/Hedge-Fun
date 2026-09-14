import { NextResponse } from "next/server";
import { authUser } from "@/lib/privy";
import { rateLimit } from "@/lib/ratelimit";
import { passStock, StockUnavailableError } from "@/lib/stocks-db";
import type { StockPassRequest, StockPassResponse } from "@/lib/api-types";

// Swipe-left: never deal this asset to this user again. Idempotent.
export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!rateLimit(`stocks-pass:${user.id}`, 120, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as Partial<StockPassRequest> | null;
  if (!body || typeof body.assetId !== "string" || body.assetId.length === 0) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    await passStock(user.id, body.assetId);
    const res: StockPassResponse = { ok: true };
    return NextResponse.json(res);
  } catch (e) {
    if (e instanceof StockUnavailableError) {
      const status = e.message === "asset_not_found" ? 404 : 409;
      return NextResponse.json({ error: e.message }, { status });
    }
    throw e;
  }
}
