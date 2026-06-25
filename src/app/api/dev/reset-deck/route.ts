import { NextResponse } from "next/server";
import { authUser } from "@/lib/privy";
import { isDevUser, resetUserDeck } from "@/lib/dev";

// Dev-only: wipe this account's bets so the whole pool is swipeable again. Fresh prices come from
// the running poller (refreshes every 60s). 403 for anyone who isn't the DEV_USER_EMAIL account.
export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isDevUser(user.email)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const reset = await resetUserDeck(user.id);
  return NextResponse.json({ ok: true, betsCleared: reset.bets });
}
