import { NextResponse } from "next/server";
import { authUser } from "@/lib/privy";
import { rateLimit } from "@/lib/ratelimit";
import { getPickers } from "@/lib/hedge/s2";
import type { HedgePickersResponse } from "@/lib/api-types";

// The PRIMARY S2 UX (spec §2): structured team/league pickers built from the OPEN, upcoming sports
// index — only entities that actually have a live market, so a pick always resolves to a real hedge.
// Server-side TTL-cached (the list churns on the poller cadence, never a static import — spec risk 4).
export async function GET(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!rateLimit(`hedge-pickers:${user.id}`, 30, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const res: HedgePickersResponse = await getPickers();
  return NextResponse.json(res);
}
