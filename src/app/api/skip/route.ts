import { NextResponse } from "next/server";
import { authUser } from "@/lib/privy";
import { recordSkip } from "@/lib/skip";
import { isDevUser } from "@/lib/dev";
import type { SkipResponse } from "@/lib/api-types";

// Skip a card: first skip/day free, each next costs 1 shard, blocked if no shards.
// Skip makes NO bet and doesn't touch the swipe cap — it just advances the deck.
// The dev test account (DEV_USER_EMAIL) skips for free, unlimited — never blocked.
export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const result: SkipResponse = await recordSkip(user.id, undefined, isDevUser(user.email));
  if (!result.ok) {
    // 402 Payment Required: a paid skip was needed but the user has no shards.
    return NextResponse.json(result, { status: 402 });
  }
  return NextResponse.json(result);
}
