import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Public liveness/readiness for external probes (UptimeRobot / CF Worker). Deliberately app+db
// ONLY — poller state is excluded (it has its own three monitoring layers, and a reboot-
// authorizing probe must not fold in poller readiness). No auth, no versions, no secrets.
export const dynamic = "force-dynamic";

let cache: { at: number; dbOk: boolean } | null = null;

export async function GET() {
  const now = Date.now();
  if (!cache || now - cache.at >= 5000) {
    let dbOk = false;
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbOk = true;
    } catch {
      dbOk = false;
    }
    cache = { at: now, dbOk };
  }
  return NextResponse.json(
    { ok: cache.dbOk, db: cache.dbOk ? "up" : "down" },
    { status: cache.dbOk ? 200 : 503 },
  );
}
