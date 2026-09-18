import { NextResponse } from "next/server";
import { authUser } from "@/lib/privy";
import { rateLimit } from "@/lib/ratelimit";
import { HeliusUnavailableError } from "@/lib/helius";
import { TxMismatchError, SponsorUnavailableError } from "@/lib/sponsor";
import { submitSigned, AttemptNotFoundError, TxRejectedError, SponsorLimitError } from "@/lib/stocks-real";
import type { StockRealSubmitRequest, StockRealSubmitResponse } from "@/lib/api-types";

// The user-signed transaction. The server verifies it against the built wire, durably stamps the
// exact signed bytes before broadcast, and adds its fee-payer signature only for sponsored attempts.
export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!rateLimit(`stocks-real-submit:${user.id}`, 10, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as Partial<StockRealSubmitRequest> | null;
  if (
    !body ||
    typeof body.attemptId !== "string" ||
    !body.attemptId ||
    typeof body.signedTransaction !== "string" ||
    !body.signedTransaction
  ) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const sig = await submitSigned(user.id, body.attemptId, body.signedTransaction);
    const res: StockRealSubmitResponse = { sig };
    return NextResponse.json(res);
  } catch (e) {
    if (e instanceof AttemptNotFoundError) {
      return NextResponse.json({ error: "attempt_not_found" }, { status: 404 });
    }
    if (e instanceof TxMismatchError) {
      return NextResponse.json({ error: "tx_mismatch" }, { status: 409 });
    }
    if (e instanceof SponsorUnavailableError) {
      return NextResponse.json({ error: "sponsor_unavailable" }, { status: 409 });
    }
    if (e instanceof SponsorLimitError) {
      return NextResponse.json({ error: "sponsor_limit" }, { status: 429 });
    }
    if (e instanceof TxRejectedError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    if (e instanceof RangeError) return NextResponse.json({ error: "bad_sig" }, { status: 400 });
    if (e instanceof HeliusUnavailableError) {
      return NextResponse.json({ error: "rpc_unavailable" }, { status: 502 });
    }
    throw e;
  }
}
