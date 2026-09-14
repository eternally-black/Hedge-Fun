import { NextResponse } from "next/server";
import { authUser } from "@/lib/privy";
import { rateLimit } from "@/lib/ratelimit";
import { recordStockConsent } from "@/lib/stocks-real";
import type { StockConsentRequest, StockConsentResponse } from "@/lib/api-types";

// Record acceptance of the xStocks terms + self-declaration at `version`. The version is checked
// against STOCK_TERMS_VERSION server-side — a stale client cannot consent to a text it never saw.
export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!rateLimit(`stocks-consent:${user.id}`, 10, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as Partial<StockConsentRequest> | null;
  if (!body || typeof body.version !== "number" || !Number.isInteger(body.version)) {
    return NextResponse.json({ error: "bad_version" }, { status: 400 });
  }

  try {
    await recordStockConsent(user.id, body.version);
  } catch (e) {
    if (e instanceof RangeError) return NextResponse.json({ error: "bad_version" }, { status: 400 });
    throw e;
  }

  const res: StockConsentResponse = { ok: true, version: body.version };
  return NextResponse.json(res);
}
