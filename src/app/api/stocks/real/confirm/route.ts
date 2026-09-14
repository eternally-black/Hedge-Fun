import { NextResponse } from "next/server";
import { authUser } from "@/lib/privy";
import { rateLimit } from "@/lib/ratelimit";
import { HeliusUnavailableError } from "@/lib/helius";
import { confirmAttempt, AttemptNotFoundError, TxNotFoundError, TxRejectedError } from "@/lib/stocks-real";
import type { StockRealConfirmRequest, StockRealConfirmResponse } from "@/lib/api-types";

// Read the landed tx from the chain and book the lot ONLY if it matches the attempt (payer, mint,
// ExactIn amount, minimum output). Idempotent by signature.
export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!rateLimit(`stocks-real-confirm:${user.id}`, 20, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as Partial<StockRealConfirmRequest> | null;
  if (!body || typeof body.attemptId !== "string" || typeof body.sig !== "string") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const result = await confirmAttempt(user.id, body.attemptId, body.sig);
    const res: StockRealConfirmResponse = result;
    return NextResponse.json(res);
  } catch (e) {
    if (e instanceof RangeError) return NextResponse.json({ error: "bad_sig" }, { status: 400 });
    if (e instanceof AttemptNotFoundError) {
      return NextResponse.json({ error: "attempt_not_found" }, { status: 404 });
    }
    if (e instanceof TxNotFoundError) {
      return NextResponse.json({ error: "tx_not_found" }, { status: 404 });
    }
    if (e instanceof TxRejectedError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    if (e instanceof HeliusUnavailableError) {
      return NextResponse.json({ error: "rpc_unavailable" }, { status: 502 });
    }
    throw e;
  }
}
