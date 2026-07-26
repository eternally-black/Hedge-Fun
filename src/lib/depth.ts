// Depth-aware market eligibility (D10 Slice A). Turns the two CLOB books of a binary market into
// the EXECUTABLE numbers we persist per side (VWAP to buy STAKE_CENTS, and the stake the book
// absorbs within the eligibility cap) plus the tradability verdict a card needs to exist at all.
// Pure math lives in src/lib/quote.ts (tested off fixtures); transport/caching in src/lib/clob.ts.
//
// TXODDS football rows have NO CLOB book (synthetic odds path, source = TXODDS): the depth gate
// must never touch them — every branch keys off `source` via depthGateApplies.

import { STAKE_CENTS, DEPTH_SLIPPAGE_CAP_BP, DEPTH_SLIPPAGE_FLOOR_BP, BOOK_MAX_STALE_MS, BOOK_MAX_DISPLAY_STALE_MS } from "./config";
import { getBook, getBooks, ClobUnavailableError } from "./clob";
import { quoteBuy, maxStakeWithinSlippage, normalizeAsks, type BookLevel } from "./quote";

// The eligibility slippage cap for ONE side, in RELATIVE bp. Two-part by design: the relative CAP is
// what a user feels (payout = stake/price), but on a cheap side one tick of book walk is a huge
// RELATIVE move while being a harmless absolute one — so the FLOOR converts 1¢ of absolute wiggle
// room into relative terms for that book's top of ask (1¢ on a 3¢ side = 3333bp relative, tolerated).
export function slippageCapBpFor(bestAskBp: number): number {
  return Math.max(
    DEPTH_SLIPPAGE_CAP_BP,
    Math.ceil((DEPTH_SLIPPAGE_FLOOR_BP * 10_000) / Math.max(1, bestAskBp)),
  );
}

// Per-side book evaluation. `asks` may come straight from TokenBook (already normalized); the
// normalize inside quote/maxStake is idempotent, so no double-sort hazard.
export interface SideEval {
  // VWAP to buy the full STAKE_CENTS. Null when the side cannot quote OR cannot fill the whole
  // stake — a partial fill has no honest "price for $10", so we store nothing rather than a fantasy.
  effPriceBp: number | null;
  maxStakeCents: number; // what the side absorbs at the eligibility cap (0 when nothing)
  tradable: boolean; // fills the WHOLE STAKE_CENTS within the eligibility cap
}

export function evalSideAsks(asks: BookLevel[]): SideEval {
  const ladder = normalizeAsks(asks);
  if (ladder.length === 0) return { effPriceBp: null, maxStakeCents: 0, tradable: false };
  const cap = slippageCapBpFor(ladder[0]!.priceBp);
  const q = quoteBuy(ladder, STAKE_CENTS);
  return {
    effPriceBp: q && q.filled ? q.effPriceBp : null,
    maxStakeCents: maxStakeWithinSlippage(ladder, cap),
    tradable: q !== null && q.filled && q.slippageBp <= cap,
  };
}

export interface MarketDepth {
  yesEffPriceBp: number | null;
  noEffPriceBp: number | null;
  yesMaxStakeCents: number;
  noMaxStakeCents: number;
  // When the book behind the four numbers was read. The pair is only as fresh as its OLDER half,
  // so this is the min of the two fetchedAtMs. Null when neither side has a book.
  bookTsAtMs: number | null;
  // BOTH sides fill STAKE_CENTS within the eligibility cap. A card offers two swipe directions, so
  // a side that can't absorb the stake kills the whole market — there is no "half-tradable" card.
  tradable: boolean;
}

// Fetch + evaluate both books of a binary market. Throws ClobUnavailableError only when the CLOB
// is unreachable AND no cached book exists to degrade to — callers treat that as "can't prove
// tradability this run" (drop the market), never as a reason to price off the mid.
export async function evalMarketDepth(yesTokenId: string, noTokenId: string): Promise<MarketDepth> {
  const books = await getBooks([yesTokenId, noTokenId]);
  const yesBook = books.get(yesTokenId) ?? null;
  const noBook = books.get(noTokenId) ?? null;
  const yes = evalSideAsks(yesBook?.asks ?? []);
  const no = evalSideAsks(noBook?.asks ?? []);
  const stamps = [yesBook?.fetchedAtMs, noBook?.fetchedAtMs].filter((t): t is number => typeof t === "number");
  return {
    yesEffPriceBp: yes.effPriceBp,
    noEffPriceBp: no.effPriceBp,
    yesMaxStakeCents: yes.maxStakeCents,
    noMaxStakeCents: no.maxStakeCents,
    bookTsAtMs: stamps.length ? Math.min(...stamps) : null,
    tradable: yes.tradable && no.tradable,
  };
}

// Batch wrapper for the refresh paths: evaluates every market concurrently — the micro-batch cache
// in clob.ts coalesces the underlying /books calls into one union request per window. Null = not
// quotable this run (missing token ids, or CLOB down with no cached book); callers gate on that.
export async function evalMarketDepthBatch(
  markets: { key: string; yesTokenId: string | null; noTokenId: string | null }[],
): Promise<Map<string, MarketDepth | null>> {
  const out = new Map<string, MarketDepth | null>();
  await Promise.all(
    markets.map(async (m) => {
      if (!m.yesTokenId || !m.noTokenId) {
        out.set(m.key, null);
        return;
      }
      try {
        out.set(m.key, await evalMarketDepth(m.yesTokenId, m.noTokenId));
      } catch (e) {
        if (e instanceof ClobUnavailableError) {
          out.set(m.key, null);
          return;
        }
        throw e;
      }
    }),
  );
  return out;
}

// Which rows the depth gate applies to. TXODDS football markets have no CLOB book at all — their
// synthetic odds path is authoritative and they must NEVER be filtered out for a null book.
export function depthGateApplies(source: string): boolean {
  return source !== "TXODDS";
}

// ─── bet-lock re-quote (D10 Slice A, step 6 server half) ─────────────────────────────────────────
// Shared by /api/swipe, /api/feed/bet and the hedge accept: quote the BOUGHT side live against the
// CLOB book and lock the VWAP the book can actually deliver. NEVER the Gamma mid — a mid lock
// silently re-introduces the exact 2x lie this work exists to kill, at the worst possible moment
// (CLOB trouble correlates with volatile books).
export type LockQuote =
  | { kind: "ok"; effPriceBp: number } // the VWAP for the full stake — lock this
  | { kind: "untradable" } // no book / one-sided book / can't fill the stake -> 409 market_untradable
  | { kind: "unavailable" }; // CLOB down or book past the freshness policy -> 502 book_unavailable

export async function requoteSideForLock(tokenId: string, stakeCents: number): Promise<LockQuote> {
  let book;
  try {
    book = await getBook(tokenId);
  } catch (e) {
    if (e instanceof ClobUnavailableError) return { kind: "unavailable" };
    throw e;
  }
  // A known-dead/absent book is not an outage — the side simply cannot be bought.
  if (!book) return { kind: "untradable" };
  // Stale-book policy (pre-Privy): refuse to lock against a book older than BOOK_MAX_STALE_MS.
  // Post-Privy this tightens to "no book, no bet" with a ~5s freshness requirement.
  if (Date.now() - book.fetchedAtMs > BOOK_MAX_STALE_MS) return { kind: "unavailable" };
  const q = quoteBuy(book.asks, stakeCents);
  // filled === false is an automatic rejection regardless of price movement — you cannot honour a
  // stake the book will not absorb.
  if (!q || !q.filled) return { kind: "untradable" };
  return { kind: "ok", effPriceBp: q.effPriceBp };
}

// The price a side actually COSTS (D10), for the deck/feed serve paths and the S2/fallback hedge
// surfaces. POLYMARKET: the book-walked VWAP (yesEffPriceBp) — and ONLY that. There is NO mid
// fallback: display is what the user acts on, so a mid-labelled card backed by no book re-introduces
// the exact seen-vs-executed lie this work exists to kill (the bid-1¢/ask-98¢ husk reads 49.5¢ on
// the mid yet books at 98¢). A POLYMARKET row with no usable book read is NOT SERVABLE (both null) —
// the serve paths drop it. The steady state is unaffected: any row that ever passed the gate carries
// persisted eff prices, so a CLOB outage degrades to slightly-stale but REAL book prices, never to a
// mid; rows never evaluated simply wait for the poller. Staleness is still bounded: a POLYMARKET row
// whose book read is older than BOOK_MAX_DISPLAY_STALE_MS is dropped rather than shown at a price
// from a dead book (looser than the 30s LOCK bound on purpose — see config.ts). TXODDS keeps its
// mid: the synthetic odds are authoritative there, not a fallback. Null pair = not servable.
export function authoritativePrices(c: {
  source: string;
  yesPriceBp: number | null;
  noPriceBp: number | null;
  yesEffPriceBp: number | null;
  noEffPriceBp: number | null;
  bookTsAt: Date | null;
}, nowMs: number): { yes: number | null; no: number | null } {
  if (c.source === "TXODDS") return { yes: c.yesPriceBp, no: c.noPriceBp };
  if (c.bookTsAt === null || nowMs - c.bookTsAt.getTime() > BOOK_MAX_DISPLAY_STALE_MS) {
    return { yes: null, no: null };
  }
  return { yes: c.yesEffPriceBp, no: c.noEffPriceBp };
}

// ─── display-quote at an arbitrary stake (hedge suggestion cards, D10 follow-up) ──────────────────
// The SAME book + VWAP path the bet-lock uses, but under the DISPLAY staleness bound: a suggestion
// card may show a slightly-stale real price, while a lock may not. Null = no honest price to show
// (no book handle is the caller's problem; here: dead/absent book, CLOB down with no cache, book
// older than BOOK_MAX_DISPLAY_STALE_MS, or the stake won't fill) — the caller drops the card rather
// than show a mid. NO slippage cap and NO band: this is display honesty, not eligibility — a $500
// hedge that walks the book is shown at its real walked VWAP, which is exactly what /accept locks.
export async function quoteSideForDisplay(tokenId: string, stakeCents: number): Promise<number | null> {
  let book;
  try {
    book = await getBook(tokenId);
  } catch (e) {
    if (e instanceof ClobUnavailableError) return null;
    throw e;
  }
  if (!book) return null;
  if (Date.now() - book.fetchedAtMs > BOOK_MAX_DISPLAY_STALE_MS) return null;
  const q = quoteBuy(book.asks, stakeCents);
  return q && q.filled ? q.effPriceBp : null;
}
