import { NextResponse } from "next/server";
import { authUser } from "@/lib/privy";
import { rateLimit } from "@/lib/ratelimit";
import { InsufficientFundsError } from "@/lib/swipe";
import { acceptSuggestion, SuggestionNotFoundError, HedgeMarketUnavailableError } from "@/lib/hedge/accept";
import type { HedgeAcceptRequest, HedgeAcceptResponse } from "@/lib/api-types";

// Accept a hedge suggestion -> a standard paper Bet with the variable stake (locked vs Cash, atomic).
// Server re-derives the suggestion from its id — client-sent market/side/stake are never trusted.
export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!rateLimit(`hedge-accept:${user.id}`, 20, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as Partial<HedgeAcceptRequest> | null;
  if (!body?.suggestionId || typeof body.suggestionId !== "string") {
    return NextResponse.json({ error: "suggestionId required" }, { status: 400 });
  }

  try {
    const result = await acceptSuggestion(user.id, body.suggestionId);
    const res: HedgeAcceptResponse = result;
    return NextResponse.json(res);
  } catch (e) {
    if (e instanceof SuggestionNotFoundError) {
      return NextResponse.json({ error: "suggestion_not_found" }, { status: 404 });
    }
    if (e instanceof HedgeMarketUnavailableError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    if (e instanceof InsufficientFundsError) {
      return NextResponse.json({ error: "insufficient_funds" }, { status: 402 });
    }
    throw e;
  }
}
