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

export async function getMarketFee(prisma: PrismaClient, market: FeeCacheRow): Promise<MarketFee> {
  const fresh =
    market.feeRateBp !== null &&
    market.feeExpMilli !== null &&
    market.feeUpdatedAt !== null &&
    Date.now() - market.feeUpdatedAt.getTime() < FEE_TTL_MS;
  if (fresh) return { rateBp: market.feeRateBp!, expMilli: market.feeExpMilli!, negRisk: market.negRisk };

  try {
    const info = (await fetchMarketInfo(polymarketPublic as never, { conditionId: market.polymarketId } as never)) as {
      feeInfo: { rate: number; exponent: number };
      negRisk: boolean;
    };
    const rateBp = Math.round(info.feeInfo.rate * 10_000);
    const expMilli = Math.round(info.feeInfo.exponent * 1000);
    await prisma.market.update({
      where: { id: market.id },
      data: { feeRateBp: rateBp, feeExpMilli: expMilli, feeUpdatedAt: new Date(), negRisk: info.negRisk },
    });
    return { rateBp, expMilli, negRisk: info.negRisk };
  } catch {
    // Stale cache beats the fallback; the fallback beats lying.
    if (market.feeRateBp !== null && market.feeExpMilli !== null) {
      return { rateBp: market.feeRateBp, expMilli: market.feeExpMilli, negRisk: market.negRisk };
    }
    return { rateBp: REAL_FEE_FALLBACK_RATE_BP, expMilli: REAL_FEE_FALLBACK_EXP_MILLI, negRisk: market.negRisk };
  }
}
