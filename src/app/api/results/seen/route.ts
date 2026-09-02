import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import { effectiveRealMode } from "@/lib/real";
import { rateLimit } from "@/lib/ratelimit";
import type { SeenResponse } from "@/lib/api-types";

// Mark all of the user's unseen settled results as seen. No body — it's all-or-nothing (the reveal
// shows every unseen result at once, so per-bet seen is YAGNI). Idempotent: only seenAt IS NULL rows
// are touched, so a second call marks 0.
export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!rateLimit(`results-seen:${user.id}`, 120, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const { count } = await prisma.bet.updateMany({
    where: {
      userId: user.id,
      mode: effectiveRealMode(user), // marks what the user was actually shown
      settlementStatus: { in: ["SETTLED", "VOID"] },
      seenAt: null,
    },
    data: { seenAt: new Date() },
  });
  const body: SeenResponse = { markedSeen: count };
  return NextResponse.json(body);
}
