import { NextResponse } from "next/server";
import { authUser } from "@/lib/privy";
import { getTickerSnapshot } from "@/lib/txodds";
import type { TickerResponse } from "@/lib/api-types";

// Live World Cup ticker. Reads TxLine via a shared server-side TTL cache (src/lib/txodds), so this
// route is a fast in-memory read and TxLine sees ~1 build per cache window regardless of traffic.
export async function GET(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const rows = await getTickerSnapshot();
  const body: TickerResponse = { rows };
  return NextResponse.json(body);
}
