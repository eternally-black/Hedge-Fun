import { NextResponse } from "next/server";
import { authUser } from "@/lib/privy";
import { recordSkip } from "@/lib/skip";
import type { SkipResponse } from "@/lib/api-types";

// Skip a card: always free and unlimited (product pivot — no shard cost). Skip makes NO bet and
// doesn't touch the swipe cap — it just advances the deck and bumps the daily skip counter.
export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const result: SkipResponse = await recordSkip(user.id);
  return NextResponse.json(result);
}
