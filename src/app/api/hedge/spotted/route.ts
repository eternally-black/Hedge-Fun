import { NextResponse } from "next/server";
import { authUser } from "@/lib/privy";
import { rateLimit } from "@/lib/ratelimit";
import { spottedForUser } from "@/lib/hedge/stock";
import { captureToGlitchTip } from "@/lib/glitchtip";
import type { HedgeSpottedResponse } from "@/lib/api-types";

// Proactive "spotted" cards: a live 24h move fired a rule's trigger. No wallet needed — the cards
// are sized off the user's persisted LifeSituation rows (else the fixed life-hedge stake).
export async function GET(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!rateLimit(`hedge-spotted:${user.id}`, 30, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  try {
    const res: HedgeSpottedResponse = {
      suggestions: await spottedForUser(user.id),
      generatedAt: new Date().toISOString(),
    };
    return NextResponse.json(res);
  } catch (e) {
    void captureToGlitchTip(e, { route: "hedge-spotted" });
    return NextResponse.json({ error: "spotted_unavailable" }, { status: 502 });
  }
}
