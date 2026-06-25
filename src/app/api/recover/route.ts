import { NextResponse } from "next/server";
import { authUser } from "@/lib/privy";
import { recoverStreak } from "@/lib/streak";

// Spend 1 artifact to revive a burned (recoverable) streak, resuming at n+1 (F7/P-10).
// recoverStreak enforces the 3-day window, the BURNED_RECOVERABLE state, and the artifact cost.
export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const result = await recoverStreak(user.id);
  if (!result.recovered) {
    // 409: not in a recoverable state, window expired, or no artifact.
    return NextResponse.json(result, { status: 409 });
  }
  return NextResponse.json(result);
}
