// Accept a hedge suggestion -> a STANDARD paper Bet (D6). Re-derives the suggestion server-side from
// its id (never trusts client-sent market/side/stake), locks the EXECUTABLE price of the chosen side
// (D10: a live CLOB re-quote for POLYMARKET rows, never the Gamma mid; a bookless source keeps its stored
// odds), and holds the VARIABLE stake against Cash with the SAME atomic model as a swipe (D8).
// Idempotent: a re-accept returns the existing bet. The bet is source=HEDGE (no points, no daily
// cap) but otherwise an ordinary Bet row, so the existing settlement poller settles it unchanged.

import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { runSerializable } from "../tx";
import { utcDay } from "../time";
import { InsufficientFundsError } from "../swipe";
import {
  DECK_MIN_LEAD_MS,
  HEDGE_MIN_STAKE_CENTS,
  HEDGE_ACCEPT_SIDE_FLOOR_BP,
  HEDGE_ACCEPT_SIDE_CEIL_BP,
} from "../config";
import { requoteSideForLock, sourceHasClobBook } from "../depth";
import { resolveDerivedSuggestion } from "./s2";

// The final accept-time price-sanity gate (F1). True when the side we're about to LOCK is priced
// inside the sane band — a decided/collapsed price (≤1% or ≥99%) fails, so a stale-cache snipe can't
// lock a degenerate price regardless of the index refresh cadence. Pure + exported for direct testing.
export function sideWithinAcceptBand(priceBp: number): boolean {
  return priceBp >= HEDGE_ACCEPT_SIDE_FLOOR_BP && priceBp <= HEDGE_ACCEPT_SIDE_CEIL_BP;
}

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

// The CLOB book behind the target market can't be quoted right now (upstream down, or past the
// freshness policy). Route -> 502 (book_unavailable) — an outage, NOT an untradable market, so the
// client may retry rather than drop the suggestion.
export class HedgeBookUnavailableError extends Error {
  constructor() {
    super("book_unavailable");
    this.name = "HedgeBookUnavailableError";
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

  // 2) Re-derive (cache-only for S1; open S2/fallback markets otherwise) and locate the suggestion.
  const item = await resolveDerivedSuggestion(userId, sid);
  if (!item) throw new SuggestionNotFoundError();
  const s = item.suggestion;
  const marketId = s.id;

  // 3) Validate the market is still tradable and lock the CURRENT price of the hedge side (D10:
  // the EXECUTABLE price for POLYMARKET — re-quoted live off the CLOB book; a bookless source keeps its
  // synthetic odds). The band check below consumes that same authoritative price, so a decided/
  // collapsed book (eff ≥99%) fails F1 even when the cached mid still reads sane.
  const market = await prisma.market.findUnique({ where: { id: marketId } });
  if (!market || market.status !== "OPEN" || market.yesPriceBp == null || market.noPriceBp == null) {
    throw new HedgeMarketUnavailableError("market not open");
  }
  if (market.resolutionDeadline.getTime() <= Date.now() + DECK_MIN_LEAD_MS) {
    throw new HedgeMarketUnavailableError("market_expired");
  }
  // Cash BEFORE the quote, so the book is asked about the stake that will actually be placed. The
  // old order quoted the full proposed stake and threw market_untradable when the book could not
  // absorb it — but the stake is clamped down to Cash a few lines later, so a user with $10 against
  // a $500 suggestion was refused on a book that would have filled their $10 several times over.
  // Quoting the smaller stake also makes the locked price the price of THAT walk rather than of a
  // deeper one the user never takes.
  const vbPre = await prisma.virtualBalance.findUnique({ where: { userId } });
  const cashPre = vbPre ? vbPre.balanceCents - vbPre.lockedCents : 0;
  const quotedStake = Math.min(s.proposedStakeCents, cashPre);
  if (quotedStake < HEDGE_MIN_STAKE_CENTS) throw new InsufficientFundsError();

  let lockedPriceBp: number;
  if (!sourceHasClobBook(market.source)) {
    lockedPriceBp = s.side === "YES" ? market.yesPriceBp : market.noPriceBp;
  } else {
    const tokenId = s.side === "YES" ? market.yesTokenId : market.noTokenId;
    if (!tokenId) throw new HedgeMarketUnavailableError("market_untradable"); // no book handle -> not quotable
    const q = await requoteSideForLock(tokenId, quotedStake);
    if (q.kind === "unavailable") throw new HedgeBookUnavailableError();
    if (q.kind !== "ok") throw new HedgeMarketUnavailableError("market_untradable"); // filled===false: the book won't absorb the stake
    lockedPriceBp = q.effPriceBp;
  }
  // Final price-sanity gate on the FRESHLY-read price (F1): a decided/collapsed side price that a
  // poller refresh landed after re-derivation -> 409, so a stale-cache snipe can't lock it.
  if (!sideWithinAcceptBand(lockedPriceBp)) {
    throw new HedgeMarketUnavailableError("price_out_of_band");
  }
  const day = utcDay();

  // 4) Atomic hold + bet + telemetry (Serializable so concurrent accepts can't double-spend Cash).
  // The stake is CLAMPED DOWN to available Cash (min/max rule vs Cash); below the floor -> reject.
  try {
    return await runSerializable<AcceptResult>(async (tx) => {
      // Re-read the market INSIDE the transaction. The tradability checks above run before it, and
      // they write nothing, so a poller refresh that resolves or closes the market in between does
      // not conflict with this transaction's writes (virtualBalance, bet) and Serializable has no
      // reason to abort it — the bet would be created against a market that is no longer open. The
      // re-read also puts the market row in this transaction's read set, so a concurrent write to it
      // can now surface as a serialization failure instead of passing unnoticed.
      const fresh = await tx.market.findUnique({
        where: { id: marketId },
        select: { status: true, resolutionDeadline: true },
      });
      if (!fresh || fresh.status !== "OPEN") throw new HedgeMarketUnavailableError("market not open");
      if (fresh.resolutionDeadline.getTime() <= Date.now() + DECK_MIN_LEAD_MS) {
        throw new HedgeMarketUnavailableError("market_expired");
      }

      const vb = await tx.virtualBalance.findUnique({ where: { userId } });
      const cash = vb ? vb.balanceCents - vb.lockedCents : 0;
      // Clamped to the QUOTED stake, never back up to the proposal: lockedPriceBp describes the walk
      // for `quotedStake`, and placing more than that would book shares at a price the book was
      // never asked about. Cash can only have fallen since, and a smaller stake fills at a price no
      // worse than the quoted one, so clamping down stays conservative.
      const stake = Math.min(quotedStake, cash);
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
          proposedStakeCents: s.proposedStakeCents, // the OFFERED (sized) stake
          actualStakeCents: stake, // the LOCKED stake (clamped down to Cash if needed) — F16
          event: "ACCEPT",
          betId: bet.id,
        },
        update: { betId: bet.id, actualStakeCents: stake },
      });
      return { betId: bet.id, stakeCents: stake, alreadyAccepted: false };
    });
  } catch (e) {
    // [userId, marketId, mode] unique: a concurrent accept of THIS suggestion, or a prior paper bet
    // on the same market from another path. If it's the same suggestion -> idempotent success; else 409.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const other = await prisma.bet.findUnique({
        where: { userId_marketId_mode: { userId, marketId, mode: "PAPER" } },
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
