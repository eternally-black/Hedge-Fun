import { NextResponse } from "next/server";
import { authUser } from "@/lib/privy";
import { rateLimit } from "@/lib/ratelimit";
import { deriveForUser } from "@/lib/hedge/suggest";
import { HeliusUnavailableError } from "@/lib/helius";
import { JupiterUnavailableError } from "@/lib/prices";
import type { HedgeSuggestionsResponse } from "@/lib/api-types";

// Deterministic S1 hedge suggestions for the caller's linked wallet(s). Reads the cached snapshot
// (rebuilds it only if the TTL lapsed); each card carries a stable suggestionId for /accept.
// quoteDisplay: every POLYMARKET card is priced live off the CLOB at its OWN proposed stake (the
// price the accept will honour), never at the Gamma mid; unquotable cards are dropped, not approximated.
export async function GET(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!rateLimit(`hedge-suggestions:${user.id}`, 30, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  try {
    const { items, walletLinked } = await deriveForUser(user.id, { quoteDisplay: true });
    const res: HedgeSuggestionsResponse = {
      suggestions: items.map((i) => i.suggestion),
      walletLinked,
    };
    return NextResponse.json(res);
  } catch (e) {
    // A stale snapshot rebuild needs Helius (balances) AND Jupiter (prices); if either is down we
    // can't derive exposure -> the same typed 502 (F4). The prior snapshot row survives untouched.
    if (e instanceof HeliusUnavailableError || e instanceof JupiterUnavailableError) {
      return NextResponse.json({ error: "exposure_unavailable" }, { status: 502 });
    }
    throw e;
  }
}
