import { NextResponse } from "next/server";
import { authUser } from "@/lib/privy";
import { rateLimit } from "@/lib/ratelimit";
import { markSent, AttemptNotFoundError, TxRejectedError } from "@/lib/stocks-real";
import type { StockRealSentRequest, StockRealSentResponse } from "@/lib/api-types";

// Stamp the signature on a SELF-PAID attempt as soon as the wallet has sent it, so the poller can
// recover a buy whose tab died before /confirm. A fee-sponsored attempt is refused (409
// not_self_paid): its signature is the server's own and /real/submit stamps it before the send —
// a client-supplied one could only ever bind some OTHER transaction to the attempt.
export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!rateLimit(`stocks-real-sent:${user.id}`, 30, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as Partial<StockRealSentRequest> | null;
  if (!body || typeof body.attemptId !== "string" || typeof body.sig !== "string") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    await markSent(user.id, body.attemptId, body.sig);
  } catch (e) {
    if (e instanceof RangeError) return NextResponse.json({ error: "bad_sig" }, { status: 400 });
    if (e instanceof AttemptNotFoundError) {
      return NextResponse.json({ error: "attempt_not_found" }, { status: 404 });
    }
    if (e instanceof TxRejectedError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    throw e;
  }

  const res: StockRealSentResponse = { ok: true };
  return NextResponse.json(res);
}
