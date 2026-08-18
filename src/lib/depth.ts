// Depth-aware market eligibility (D10 Slice A). Turns the two CLOB books of a binary market into
// the EXECUTABLE numbers we persist per side (VWAP to buy STAKE_CENTS, and the stake the book
// absorbs within the eligibility cap) plus the tradability verdict a card needs to exist at all.
// Pure math lives in src/lib/quote.ts (tested off fixtures); transport/caching in src/lib/clob.ts.
//
// ─── the bookless-source path (see sourceHasClobBook) ────────────────────────────────────────────
// A row from a source with NO CLOB book at all serves its stored odds, and the depth gate must never
// drop it for a null book. TxOdds football was the only such source and it is gone; today the path
// is exercised only by the DB test suites (test-api-contract, test-route-guards, test-hedge-accept,
// test-hedge-s2), which seed `source: "TXODDS"` rows precisely because they have no book to quote.
//
// It survives the removal as a judgement call, not an oversight. The alternative — delete it and
// re-seed those four suites against a stubbed CLOB book — is possible (postBooks reads
// globalThis.fetch at call time, and test-clob/test-depth-gate already stub it that way), but it
// means rewriting every locked-price and P&L assertion in them from a 5000bp mid to a book-walked
// VWAP. That is churn across the most safety-critical assertions in the repo for no product gain.
// ponytail: ~6 small branches kept for test fixtures. Delete them when those suites move to a
// stubbed book — the seam already exists, it just wasn't worth spending on today.
//
// Every site that cares goes through sourceHasClobBook() below — see the note there for why that
// matters more than it looks.

import {
  STAKE_CENTS,
  DEPTH_SLIPPAGE_CAP_BP,
  DEPTH_SLIPPAGE_FLOOR_BP,
  BOOK_MAX_STALE_MS,
  BOOK_MAX_DISPLAY_STALE_MS,
  QUOTE_TOLERANCE_BP,
  QUOTE_TOLERANCE_FLOOR_BP,
} from "./config";
import { getBook, getBooks, ClobUnavailableError } from "./clob";
import { quoteBuy, maxStakeWithinSlippage, marketableBuyBoundBp, normalizeAsks, type BookLevel } from "./quote";

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
// from a dead book (looser than the 30s LOCK bound on purpose — see config.ts). A bookless source
// keeps its stored odds: authoritative there, not a fallback (see the header). Null pair = not servable.
// Does this market source have a real CLOB book behind it? Everything price-related keys off this:
// the depth gate, the live re-quote at bet time, the display staleness bound, and QuoteRow.live.
//
// It exists as one predicate rather than six inline comparisons for one reason. The natural way to
// write those comparisons is against the BOOKLESS pole (`!== "POLYMARKET"`), and then a third source
// added later inherits the bookless treatment SILENTLY: its stored mid served as authoritative, no
// re-quote before a bet locks, no depth gate, no staleness bound. That is a money path failing open.
// Adding a source now means editing this one allow-list and making the decision on purpose.
export function sourceHasClobBook(source: string): boolean {
  return source === "POLYMARKET";
}

export function authoritativePrices(c: {
  source: string;
  yesPriceBp: number | null;
  noPriceBp: number | null;
  yesEffPriceBp: number | null;
  noEffPriceBp: number | null;
  bookTsAt: Date | null;
}, nowMs: number): { yes: number | null; no: number | null } {
  if (!sourceHasClobBook(c.source)) return { yes: c.yesPriceBp, no: c.noPriceBp };
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
// Both sides of one market, for the LIVE card poll (/api/quotes, D10 Slice B). Same book + VWAP path
// as quoteSideForDisplay, but returns the pair plus an honest `asOfMs` so the client can tell a
// just-read quote from one served out of the stale cache during a CLOB wobble. asOfMs is the OLDER
// of the two book reads — a pair is only as fresh as its stalest half.
export interface DisplayQuote {
  yesPriceBp: number | null;
  noPriceBp: number | null;
  asOfMs: number | null; // null when neither side had a usable book
}

// `slipBp` turns the displayed price into the PROMISE the order will carry: the marketable bound
// for this stake, not the VWAP the book would give right now. Real money only, and deliberately so —
// the card then states the worst price the user can be charged, the exchange normally fills better,
// and the one thing that cannot happen is the number moving against them after they swiped. Paper
// keeps the plain VWAP: nothing there is executed, so a conservative price would just be a worse
// game. See REAL_SLIPPAGE_BP for why the allowance is not zero.
export async function quoteMarketForDisplay(
  yesTokenId: string,
  noTokenId: string,
  stakeCents: number,
  slipBp = 0,
): Promise<DisplayQuote> {
  let books;
  try {
    books = await getBooks([yesTokenId, noTokenId]);
  } catch (e) {
    if (e instanceof ClobUnavailableError) return { yesPriceBp: null, noPriceBp: null, asOfMs: null };
    throw e;
  }
  const now = Date.now();
  const side = (tokenId: string): { priceBp: number | null; at: number | null } => {
    const b = books.get(tokenId);
    if (!b || now - b.fetchedAtMs > BOOK_MAX_DISPLAY_STALE_MS) return { priceBp: null, at: null };
    const q = quoteBuy(b.asks, stakeCents);
    if (!q || !q.filled) return { priceBp: null, at: b.fetchedAtMs };
    const tickBp = Math.round(b.tickSize * 10_000);
    const priceBp = slipBp > 0 && tickBp > 0 ? marketableBuyBoundBp(q.marginalPriceBp, tickBp, slipBp) : q.effPriceBp;
    return { priceBp, at: b.fetchedAtMs };
  };
  const y = side(yesTokenId);
  const n = side(noTokenId);
  const stamps = [y.at, n.at].filter((t): t is number => t !== null);
  return {
    yesPriceBp: y.priceBp,
    noPriceBp: n.priceBp,
    asOfMs: stamps.length ? Math.min(...stamps) : null,
  };
}

// Did the price move AGAINST the user beyond what we promised? PURE, so the fairness rule is
// testable in isolation and identical on every bet surface.
//
// Asymmetric on purpose: a price that moved in the user's FAVOUR is executed silently (consistent
// with the round-UP, under-promise philosophy — nobody wants a 409 telling them they got a better
// deal). Only a move against them can reject.
//
// The threshold is relative WITH an absolute floor. Relative alone is unusable on a cheap side: 2%
// of a 5¢ price is 10bp, i.e. one tick, so a 3¢ card would 409 on every ordinary book wiggle. The
// floor converts that into "a tick or two of absolute room" without loosening the guarantee where it
// matters (a 2% drift on a 90¢ side is still 2%).
export function quoteMovedAgainstUser(seenPriceBp: number, freshPriceBp: number): boolean {
  if (!(seenPriceBp > 0)) return false; // no honest quote to compare against -> never reject
  const allowed = Math.max(
    Math.round((seenPriceBp * QUOTE_TOLERANCE_BP) / 10_000),
    QUOTE_TOLERANCE_FLOOR_BP,
  );
  return freshPriceBp - seenPriceBp > allowed;
}

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
