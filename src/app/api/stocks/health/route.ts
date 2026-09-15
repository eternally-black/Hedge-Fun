import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { STOCK_HEALTH_MIN_DECK, STOCK_HEALTH_STUCK_ATTEMPT_MS, STOCK_PRICE_MAX_STALE_MS, STOCK_SPONSOR_MIN_LAMPORTS } from "@/lib/config";
import { sponsorConfigured, sponsorAddress } from "@/lib/sponsor";
import { getBalanceLamports } from "@/lib/helius";

// Public probe for the tokenized-stock surface (Uptime Kuma keyword monitor). Answers TWO questions
// from the outside: can a user see a stocks deck right now, and can they still trade? 503 when fewer
// than STOCK_HEALTH_MIN_DECK deck-eligible assets carry a fresh Jupiter price (a dead poller, a
// Jupiter outage or an empty catalog), or when the fee-payer wallet has dropped below
// STOCK_SPONSOR_MIN_LAMPORTS — a drained sponsor fails every gasless buy/sell with no other outside
// symptom. None of this can be seen from /api/health (app+db only, by design — this probe never
// authorises a reboot). No auth, no secrets, counts only, cached 5 s. The sponsor's ADDRESS is public
// information but is left out anyway: the balance is what ops acts on.
export const dynamic = "force-dynamic";

type Body = {
  ok: boolean;
  assets: number;
  deckFresh: number;
  oldestFreshAgeSec: number | null;
  stuckAttempts: number;
  sponsorLamports: string | null;
  sponsorOk: boolean;
};
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
      // No sponsor configured = the self-paid path, which needs no fee-payer: ok by definition.
      // Configured but unreadable (RPC down, or an address we failed to derive) is NOT ok — an
      // unknown balance is the case where sponsored trades silently start failing.
      let sponsorLamports: string | null = null;
      let sponsorOk = !sponsorConfigured();
      const addr = sponsorAddress();
      if (!sponsorOk && addr) {
        try {
          const lamports = await getBalanceLamports(addr);
          sponsorLamports = lamports.toString();
          sponsorOk = lamports >= BigInt(STOCK_SPONSOR_MIN_LAMPORTS);
        } catch {
          // keep null / false
        }
      }
      body = {
        ok: deckFresh >= STOCK_HEALTH_MIN_DECK && sponsorOk,
        assets,
        deckFresh,
        oldestFreshAgeSec: oldest?.pricedAt ? Math.round((now - oldest.pricedAt.getTime()) / 1000) : null,
        stuckAttempts,
        sponsorLamports,
        sponsorOk,
      };
    } catch {
      body = { ok: false, assets: 0, deckFresh: 0, oldestFreshAgeSec: null, stuckAttempts: 0, sponsorLamports: null, sponsorOk: false };
    }
    cache = { at: now, body };
  }
  return NextResponse.json(cache.body, { status: cache.body.ok ? 200 : 503 });
}
