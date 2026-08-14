// Per-market platform-fee cache (plan §2.6). The fee params live on the Market row with a 24h TTL
// and refresh AT INTENT TIME through the credential-free public client — the poller stays SDK-free,
// and the fee is freshest exactly when money moves. Fallback is the most PESSIMISTIC measured rate:
// overstating a fee shrinks a hedge slightly; understating one lies on the card.
// NB: imports the SDK — test scripts must not import this module (tsx cannot resolve the SDK root).
import type { PrismaClient } from "@prisma/client";
import { fetchMarketInfo } from "@polymarket/client/actions";
import { polymarketPublic } from "./polymarket-sdk";
import { REAL_FEE_FALLBACK_RATE_BP, REAL_FEE_FALLBACK_EXP_MILLI } from "./config";

const FEE_TTL_MS = 24 * 60 * 60 * 1000;

export type MarketFee = { rateBp: number; expMilli: number; negRisk: boolean | null };

type FeeCacheRow = {
  id: string;
  polymarketId: string; // = the Gamma conditionId for POLYMARKET rows
  feeRateBp: number | null;
  feeExpMilli: number | null;
  feeUpdatedAt: Date | null;
  negRisk: boolean | null;
};

// The fee a formula pair implies at p=0.5, where it peaks — the pessimism yardstick.
const feeAt50 = (rateBp: number, expMilli: number) => (rateBp / 10_000) * Math.pow(0.25, expMilli / 1000);
const STALE_MAX_MS = 7 * 24 * 60 * 60 * 1000;

// Single-flight per market: an intent burst on a stale row must not stampede the endpoint or
// overwrite the cache out of order (Sol S5 #9).
const inflight = new Map<string, Promise<MarketFee>>();

export async function getMarketFee(prisma: PrismaClient, market: FeeCacheRow): Promise<MarketFee> {
  const fresh =
    market.feeRateBp !== null &&
    market.feeExpMilli !== null &&
    market.feeUpdatedAt !== null &&
    Date.now() - market.feeUpdatedAt.getTime() < FEE_TTL_MS;
  if (fresh) return { rateBp: market.feeRateBp!, expMilli: market.feeExpMilli!, negRisk: market.negRisk };

  const running = inflight.get(market.id);
  if (running) return running;
  const p = refreshMarketFee(prisma, market).finally(() => inflight.delete(market.id));
  inflight.set(market.id, p);
  return p;
}

async function refreshMarketFee(prisma: PrismaClient, market: FeeCacheRow): Promise<MarketFee> {
  let fetched: { rateBp: number; expMilli: number; negRisk: boolean } | null = null;
  try {
    const info = (await fetchMarketInfo(polymarketPublic as never, { conditionId: market.polymarketId } as never)) as {
      feeInfo: { rate: number; exponent: number };
      negRisk: boolean;
    };
    const rateBp = Math.round(info.feeInfo.rate * 10_000);
    const expMilli = Math.round(info.feeInfo.exponent * 1000);
    // Validate before caching: a malformed pair must not poison quoting (quote.ts refuses it too).
    if (rateBp >= 0 && rateBp <= 2_000 && expMilli > 0 && expMilli <= 5_000) {
      fetched = { rateBp, expMilli, negRisk: info.negRisk };
    }
  } catch {
    // fall through to the stale/fallback policy
  }

  if (fetched) {
    try {
      await prisma.market.update({
        where: { id: market.id },
        data: { feeRateBp: fetched.rateBp, feeExpMilli: fetched.expMilli, feeUpdatedAt: new Date(), negRisk: fetched.negRisk },
      });
    } catch {
      // Persist failure must NOT discard a known-fresh fee (Sol S5 #3) — serve it uncached.
    }
    return fetched;
  }

  // Fetch failed. Bounded-stale beats fallback; beyond the bound, whichever is MORE pessimistic
  // at p=0.5 wins — an outage must never let a historically-low fee underquote indefinitely.
  const staleOk =
    market.feeRateBp !== null &&
    market.feeExpMilli !== null &&
    market.feeUpdatedAt !== null &&
    Date.now() - market.feeUpdatedAt.getTime() < STALE_MAX_MS;
  if (staleOk) return { rateBp: market.feeRateBp!, expMilli: market.feeExpMilli!, negRisk: market.negRisk };
  const fallback = { rateBp: REAL_FEE_FALLBACK_RATE_BP, expMilli: REAL_FEE_FALLBACK_EXP_MILLI, negRisk: market.negRisk };
  if (market.feeRateBp !== null && market.feeExpMilli !== null) {
    return feeAt50(market.feeRateBp, market.feeExpMilli) >= feeAt50(fallback.rateBp, fallback.expMilli)
      ? { rateBp: market.feeRateBp, expMilli: market.feeExpMilli, negRisk: market.negRisk }
      : fallback;
  }
  return fallback;
}
