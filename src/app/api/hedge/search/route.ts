import { NextResponse } from "next/server";
import { authUser } from "@/lib/privy";
import { rateLimit } from "@/lib/ratelimit";
import { searchLife } from "@/lib/hedge/stock";
import type { HedgeSearchRequest, HedgeSearchResponse } from "@/lib/api-types";

// The SECONDARY S2 UX: free text -> deterministic alias/FTS match -> (below threshold + key) ONE NLU
// call -> re-run -> discovery fallback. A team you SUPPORT yields an AGAINST suggestion on its nearest
// upcoming market; nothing matched -> 3 random contested markets flagged is_discovery (never a hedge).
// The LLM never picks side/size/market (D1) — it only re-seeds the deterministic search (D2).
export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // The free-text path can reach the LLM (NLU edge) — rate-limit it before it touches the network.
  if (!rateLimit(`hedge-search:${user.id}`, 20, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as Partial<HedgeSearchRequest> | null;
  const text = (body?.text ?? "").toString().trim();
  if (!text || text.length > 200) {
    return NextResponse.json({ error: "text required (1..200 chars)" }, { status: 400 });
  }

  // Optional stated amount (a chip's amount field). An amount inside the text wins over it.
  const rawAmount = body?.amountCents;
  let amountCents: number | null = null;
  if (rawAmount != null) {
    if (!Number.isInteger(rawAmount) || rawAmount < 0 || rawAmount > 10_000_000) {
      return NextResponse.json({ error: "bad_amount" }, { status: 400 });
    }
    amountCents = rawAmount;
  }

  const out = await searchLife(user.id, text, amountCents);
  const res: HedgeSearchResponse = {
    suggestions: out.suggestions,
    isDiscovery: out.isDiscovery,
    matchedEntity: out.matchedEntity,
    usedNlu: out.usedNlu,
    stockSuggestions: out.stockSuggestions,
    situation: out.situation,
  };
  return NextResponse.json(res);
}
