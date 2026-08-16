import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUser } from "@/lib/privy";
import type { SeenResponse } from "@/lib/api-types";

// Mark all of the user's unseen settled results as seen. No body — it's all-or-nothing (the reveal
// shows every unseen result at once, so per-bet seen is YAGNI). Idempotent: only seenAt IS NULL rows
// are touched, so a second call marks 0.
export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { count } = await prisma.bet.updateMany({
    where: { userId: user.id, mode: "PAPER", settlementStatus: { in: ["SETTLED", "VOID"] }, seenAt: null },
    data: { seenAt: new Date() },
  });
  const body: SeenResponse = { markedSeen: count };
  return NextResponse.json(body);
}
