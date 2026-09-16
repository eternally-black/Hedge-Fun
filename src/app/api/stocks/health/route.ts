import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { STOCK_HEALTH_MIN_DECK, STOCK_HEALTH_STUCK_ATTEMPT_MS, STOCK_PRICE_MAX_STALE_MS, STOCK_SPONSOR_MIN_LAMPORTS } from "@/lib/config";
import { sponsorConfigured, sponsorAddress } from "@/lib/sponsor";
import { getBalanceLamports } from "@/lib/helius";
import { withDeadline } from "@/lib/deadline";

// Public probe for the tokenized-stock surface (Uptime Kuma keyword monitor). Answers TWO questions
// from the outside: can a user see a stocks deck right now, and can they still trade? 503 when fewer
// than STOCK_HEALTH_MIN_DECK deck-eligible assets carry a fresh Jupiter price (a dead poller, a
// Jupiter outage or an empty catalog), or when the fee-payer wallet has dropped below
// STOCK_SPONSOR_MIN_LAMPORTS — a drained sponsor fails every gasless buy/sell with no other outside
// symptom. None of this can be seen from /api/health (app+db only, by design — this probe never
// authorises a reboot). No auth, no secrets, counts only, cached 5 s. The sponsor's ADDRESS is public
// information but is left out anyway: the balance is what ops acts on.
export const dynamic = "force-dynamic";

const CACHE_MS = 5000;
const SPONSOR_READ_BUDGET_MS = 4000;

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
// One refresh at a time. A monitor plus a cold cache plus a burst of curious clients used to mean N ×
// (4 DB reads + 1 RPC) in the same second — the probe itself becoming the load it reports on.
let inflight: Promise<Body> | null = null;

async function refresh(): Promise<Body> {
  const now = Date.now();
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
        // A probe that hangs on a slow RPC is a monitor that pages for the wrong reason: the Helius
        // client honours the ambient budget (src/lib/deadline.ts), so 4 s is all this read may take.
        const lamports = await withDeadline(SPONSOR_READ_BUDGET_MS, () => getBalanceLamports(addr));
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
  cache = { at: Date.now(), body };
  return body;
}

export async function GET() {
  const hot = cache && Date.now() - cache.at < CACHE_MS ? cache.body : null;
  // A miss while a refresh is already running waits for THAT one (refresh never rejects).
  const body = hot ?? (await (inflight ??= refresh().finally(() => (inflight = null))));
  return NextResponse.json(body, { status: body.ok ? 200 : 503 });
}
