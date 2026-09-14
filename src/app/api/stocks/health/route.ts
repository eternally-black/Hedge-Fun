import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { STOCK_HEALTH_MIN_DECK, STOCK_HEALTH_STUCK_ATTEMPT_MS, STOCK_PRICE_MAX_STALE_MS } from "@/lib/config";

// Public probe for the tokenized-stock surface (Uptime Kuma keyword monitor). Answers ONE question
// from the outside: can a user see a stocks deck right now? 503 when fewer than STOCK_HEALTH_MIN_DECK
// deck-eligible assets carry a fresh Jupiter price — a dead poller, a Jupiter outage or an empty
// catalog all land here, and none of them can be seen from /api/health (app+db only, by design —
// this probe never authorises a reboot). No auth, no secrets, counts only, cached 5 s.
export const dynamic = "force-dynamic";

type Body = { ok: boolean; assets: number; deckFresh: number; oldestFreshAgeSec: number | null; stuckAttempts: number };
let cache: { at: number; body: Body } | null = null;

export async function GET() {
  const now = Date.now();
  if (!cache || now - cache.at >= 5000) {
    let body: Body;
    try {
      const freshSince = new Date(now - STOCK_PRICE_MAX_STALE_MS);
      const [assets, deckFresh, oldest, stuckAttempts] = await Promise.all([
        prisma.stockAsset.count(),
        prisma.stockAsset.count({ where: { deckEligible: true, pricedAt: { gt: freshSince } } }),
        prisma.stockAsset.findFirst({ where: { deckEligible: true, pricedAt: { gt: freshSince } }, orderBy: { pricedAt: "asc" }, select: { pricedAt: true } }),
        prisma.stockBuyAttempt.count({ where: { status: "PENDING", createdAt: { lt: new Date(now - STOCK_HEALTH_STUCK_ATTEMPT_MS) } } }),
      ]);
      body = {
        ok: deckFresh >= STOCK_HEALTH_MIN_DECK,
        assets,
        deckFresh,
        oldestFreshAgeSec: oldest?.pricedAt ? Math.round((now - oldest.pricedAt.getTime()) / 1000) : null,
        stuckAttempts,
      };
    } catch {
      body = { ok: false, assets: 0, deckFresh: 0, oldestFreshAgeSec: null, stuckAttempts: 0 };
    }
    cache = { at: now, body };
  }
  return NextResponse.json(cache.body, { status: cache.body.ok ? 200 : 503 });
}
