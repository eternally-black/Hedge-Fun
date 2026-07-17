// Accept a hedge suggestion -> a STANDARD paper Bet (D6). Re-derives the suggestion server-side from
// its id (never trusts client-sent market/side/stake), locks the live price of the chosen side, and
// holds the VARIABLE stake against Cash with the SAME atomic model as a swipe (D8). Idempotent: a
// re-accept returns the existing bet. The bet is source=HEDGE (no points, no daily cap) but otherwise
// an ordinary Bet row, so the existing settlement poller settles it unchanged.

import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { runSerializable } from "../tx";
import { utcDay } from "../time";
import { InsufficientFundsError } from "../swipe";
import { DECK_MIN_LEAD_MS, HEDGE_MIN_STAKE_CENTS } from "../config";
import { deriveForUser } from "./suggest";

// The suggestion id doesn't resolve to a current suggestion for the user's wallet(s) — stale
// (snapshot refreshed / index changed / market closed). Route -> 404; the client refetches.
export class SuggestionNotFoundError extends Error {
  constructor() {
    super("hedge suggestion not found (stale)");
    this.name = "SuggestionNotFoundError";
  }
}

// The target market can't be bet right now (not OPEN, no prices, too close to resolution, or already
// bet on a different suggestion). Route -> 409.
export class HedgeMarketUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HedgeMarketUnavailableError";
  }
}

export interface AcceptResult {
  betId: string;
  stakeCents: number;
  alreadyAccepted: boolean;
}

export async function acceptSuggestion(userId: string, sid: string): Promise<AcceptResult> {
  // 1) Idempotency fast path: this suggestion was already accepted -> return that bet.
  const prior = await prisma.bet.findFirst({
    where: { userId, hedgeSuggestionId: sid },
    select: { id: true, stakeCents: true },
  });
  if (prior) return { betId: prior.id, stakeCents: prior.stakeCents, alreadyAccepted: true };

  // 2) Re-derive (cache-only) and locate the suggestion the id refers to.
  const { items } = await deriveForUser(userId, { cacheOnly: true });
  const item = items.find((i) => i.suggestion.suggestionId === sid);
  if (!item) throw new SuggestionNotFoundError();
  const s = item.suggestion;
  const marketId = s.id;

  // 3) Validate the market is still tradable and lock the CURRENT price of the hedge side.
  const market = await prisma.market.findUnique({ where: { id: marketId } });
  if (!market || market.status !== "OPEN" || market.yesPriceBp == null || market.noPriceBp == null) {
    throw new HedgeMarketUnavailableError("market not open");
  }
  if (market.resolutionDeadline.getTime() <= Date.now() + DECK_MIN_LEAD_MS) {
    throw new HedgeMarketUnavailableError("market_expired");
  }
  const lockedPriceBp = s.side === "YES" ? market.yesPriceBp : market.noPriceBp;
  const day = utcDay();

  // 4) Atomic hold + bet + telemetry (Serializable so concurrent accepts can't double-spend Cash).
  // The stake is CLAMPED DOWN to available Cash (min/max rule vs Cash); below the floor -> reject.
  try {
    return await runSerializable<AcceptResult>(async (tx) => {
      const vb = await tx.virtualBalance.findUnique({ where: { userId } });
      const cash = vb ? vb.balanceCents - vb.lockedCents : 0;
      const stake = Math.min(s.proposedStakeCents, cash);
      if (stake < HEDGE_MIN_STAKE_CENTS) throw new InsufficientFundsError();

      await tx.virtualBalance.update({ where: { userId }, data: { lockedCents: { increment: stake } } });
      const bet = await tx.bet.create({
        data: {
          userId,
          marketId,
          side: s.side,
          stakeCents: stake,
          lockedPriceBp,
          utcDay: day,
          source: "HEDGE",
          hedgeSuggestionId: sid,
        },
        select: { id: true },
      });
      await tx.hedgeSuggestionEvent.upsert({
        where: { userId_suggestionId_event: { userId, suggestionId: sid, event: "ACCEPT" } },
        create: {
          suggestionId: sid,
          userId,
          address: item.address,
          marketId,
          kind: item.enumKind,
          side: s.side,
          proposedStakeCents: s.proposedStakeCents,
          event: "ACCEPT",
          betId: bet.id,
        },
        update: { betId: bet.id },
      });
      return { betId: bet.id, stakeCents: stake, alreadyAccepted: false };
    });
  } catch (e) {
    // [userId, marketId] unique: a concurrent accept of THIS suggestion, or a prior bet on the same
    // market from another path. If it's the same suggestion -> idempotent success; else 409.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const other = await prisma.bet.findUnique({
        where: { userId_marketId: { userId, marketId } },
        select: { id: true, stakeCents: true, hedgeSuggestionId: true },
      });
      if (other?.hedgeSuggestionId === sid) {
        return { betId: other.id, stakeCents: other.stakeCents, alreadyAccepted: true };
      }
      throw new HedgeMarketUnavailableError("already bet this market");
    }
    throw e;
  }
}
