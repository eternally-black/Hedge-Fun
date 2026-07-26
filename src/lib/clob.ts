// Polymarket CLOB read-integration (REST /books). Read-only — no orders, wallets, signatures.
// Base: https://clob.polymarket.com
//
// Verified facts (re-checked by scripts/verify-clob.ts):
//  - POST {CLOB_BASE}/books, body [{ token_id }], accepts a BATCH (we chunk at 200).
//  - The response is an array of book summaries matched by `asset_id` — it is NOT in request order.
//    Matching by asset_id is LOAD-BEARING: assuming positional order is the single easiest way to
//    corrupt every price in the system.
//  - Each book: { market, asset_id, hash, timestamp, min_order_size, tick_size, neg_risk, bids, asks }
//    with levels { price: "0.52", size: "123.45" } as decimal STRINGS.
//  - A token with NO orders is OMITTED from the response entirely (verified live 2026-07-26: an
//    omitted token re-requested alone still returns nothing); a few come back as an explicit entry
//    with both sides empty. Both spell "dead book" — toTokenBook/flush treat both as authoritative
//    null and negative-cache them.
//
// Caching is a MICRO-BATCH FLUSH (coalescing spirit of src/lib/txodds.ts getTickerSnapshot and
// src/lib/birdeye.ts getWalletAvgCost): misses collect for ~15ms, ONE /books call fetches the union,
// every waiter resolves from the asset_id-matched response. The TTL only throttles fetches — the
// cache NEVER decides what is fresh enough to USE. Freshness policy (BOOK_MAX_STALE_MS at bet-lock
// time) lives in the callers, which read the honest fetchedAtMs off every book.

import { BOOK_CACHE_TTL_MS } from "./config";
import { normalizeAsks, normalizeBids, type BookLevel } from "./quote";

// Thrown when the CLOB can't answer (HTTP error, timeout, transport failure) AND there is no cached
// book to degrade to. Mirrors JupiterUnavailableError (src/lib/prices.ts): routes map this to a
// typed 502 (book_unavailable) rather than a bare 500.
export class ClobUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClobUnavailableError";
  }
}

const BASE = process.env.POLYMARKET_CLOB_BASE ?? "https://clob.polymarket.com";
const TIMEOUT_MS = 8_000;
const CHUNK = 200; // token ids per /books call
const FLUSH_DELAY_MS = 15; // micro-batch window: collect misses, send ONE union request
const MAX_IN_FLIGHT_BATCHES = 2; // at most 1–2 /books batches in flight per process
const MAX_RETRIES = 2; // 429/5xx/transport retries with bounded backoff (observed != contracted)
const RETRY_BACKOFF_MS = [250, 500];
const MAP_CAP = 5_000; // bound the cache/lastGood maps (crypto minute markets churn thousands of tokens)

export interface TokenBook {
  tokenId: string; // the CLOB asset_id this book belongs to (matched, never positional)
  asks: BookLevel[]; // normalized cheapest-first (a BUY walks these)
  bids: BookLevel[]; // normalized highest-first (depth diagnostics only — never priced off)
  fetchedAtMs: number; // when WE read this book (local receipt clock) — honest even when stale-served
  minOrderSize: number; // shares (upstream minimum order)
  tickSize: number; // price tick in dollars (e.g. 0.01)
}

// Raw upstream shape (only the fields we read).
interface RawBook {
  market?: string;
  asset_id?: string;
  hash?: string;
  timestamp?: string;
  min_order_size?: string | number;
  tick_size?: string | number;
  neg_risk?: boolean;
  bids?: { price?: string | number; size?: string | number }[];
  asks?: { price?: string | number; size?: string | number }[];
}

function parseLevels(levels: RawBook["asks"]): BookLevel[] {
  if (!Array.isArray(levels)) return [];
  const out: BookLevel[] = [];
  for (const l of levels) {
    const priceBp = Math.round(Number(l?.price) * 10_000);
    const size = Number(l?.size);
    out.push({ priceBp, size }); // junk (NaN/0) is dropped by normalize* below, in ONE place
  }
  return out;
}

// One attempt at the raw POST. Exported for the canary (scripts/verify-clob.ts asserts the upstream
// shape through the same code path the flush uses). `tokenIds` must already be <= CHUNK.
export async function postBooks(tokenIds: string[]): Promise<RawBook[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/books`, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(tokenIds.map((token_id) => ({ token_id }))),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new ClobStatusError(res.status);
    return (await res.json()) as RawBook[];
  } finally {
    clearTimeout(t);
  }
}

// Internal marker so the retry loop can distinguish retryable statuses from a hard 4xx.
class ClobStatusError extends Error {
  constructor(readonly status: number) {
    super(`CLOB ${status}`);
  }
}

async function postBooksWithRetry(tokenIds: string[]): Promise<RawBook[]> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[attempt - 1]));
    try {
      return await postBooks(tokenIds);
    } catch (e) {
      // A non-429 4xx is a contract problem, not congestion — retrying can't heal it.
      if (e instanceof ClobStatusError && e.status !== 429 && e.status < 500) {
        throw new ClobUnavailableError(`CLOB ${e.status} (not retryable)`);
      }
      lastErr = e as Error; // 429 / 5xx / timeout / transport -> bounded backoff, then give up
    }
  }
  throw new ClobUnavailableError(`CLOB /books failed after ${MAX_RETRIES + 1} attempts: ${lastErr?.message}`);
}

// ─── micro-batch flush cache ──────────────────────────────────────────────────────────────────────

interface CacheEntry {
  book: TokenBook | null; // null = known-dead/absent book (negative cache, same TTL)
  expiresAtMs: number;
}
interface Waiter {
  resolve: (b: TokenBook | null) => void;
  reject: (e: Error) => void;
}

const bookCache = new Map<string, CacheEntry>();
// The last NON-NULL book per token, served on upstream failure with its ORIGINAL fetchedAtMs. An
// authoritative empty/absent book CLEARS it — keeping a ghost book would re-introduce a price the
// market can no longer back (bounded by BOOK_MAX_STALE_MS at the callers, but why lie at all).
const lastGood = new Map<string, TokenBook>();
let window_: Map<string, Waiter[]> = new Map(); // ids waiting for the NEXT flush
const inFlight: Map<string, Waiter[]> = new Map(); // ids covered by a running flush (late callers join)
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let inFlightBatches = 0;
const slotQueue: (() => void)[] = [];

// Cheap bound against unbounded growth (see MAP_CAP): drop the oldest-inserted quarter. Insertion
// order is Map iteration order, so this approximates LRU without any bookkeeping.
function trimMap<V>(map: Map<string, V>): void {
  if (map.size <= MAP_CAP) return;
  const drop = Math.ceil(MAP_CAP / 4);
  let i = 0;
  for (const k of map.keys()) {
    map.delete(k);
    if (++i >= drop) break;
  }
}

function enqueue(tokenId: string): Promise<TokenBook | null> {
  return new Promise((resolve, reject) => {
    const existing = inFlight.get(tokenId) ?? window_.get(tokenId);
    if (existing) {
      existing.push({ resolve, reject });
      return;
    }
    window_.set(tokenId, [{ resolve, reject }]);
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        void flush();
      }, FLUSH_DELAY_MS);
    }
  });
}

async function flush(): Promise<void> {
  const batch = window_;
  window_ = new Map();
  // Late callers for these ids join the RUNNING batch instead of double-fetching (single-flight).
  for (const [id, ws] of batch) {
    const cur = inFlight.get(id);
    if (cur) cur.push(...ws);
    else inFlight.set(id, [...ws]);
  }
  // Bound in-flight batches: queue behind a slot rather than stampeding the CLOB.
  if (inFlightBatches >= MAX_IN_FLIGHT_BATCHES) {
    await new Promise<void>((r) => slotQueue.push(r));
  }
  inFlightBatches++;
  try {
    const ids = [...batch.keys()];
    const resolved = new Map<string, TokenBook | null>(); // authoritative answers (chunk succeeded)
    const chunkFailed = new Set<string>(); // ids whose /books call failed outright
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      let raw: RawBook[];
      try {
        raw = await postBooksWithRetry(chunk);
      } catch {
        for (const id of chunk) chunkFailed.add(id);
        continue;
      }
      // Match by asset_id — the response is NOT in request order (verified; see header).
      const byAssetId = new Map(raw.map((b) => [b.asset_id, b]));
      for (const id of chunk) {
        const r = byAssetId.get(id);
        resolved.set(id, r ? toTokenBook(r) : null); // absent/empty = authoritative dead book
      }
    }
    const expiresAtMs = Date.now() + BOOK_CACHE_TTL_MS;
    const unavailable = new ClobUnavailableError("CLOB unreachable and no cached book");
    for (const id of ids) {
      const waiters = inFlight.get(id) ?? [];
      inFlight.delete(id);
      if (chunkFailed.has(id)) {
        // Upstream failure: serve the last good book with its HONEST (original) fetchedAtMs — the
        // caller's freshness policy decides if it's still usable. No last good -> typed failure.
        const stale = lastGood.get(id);
        if (stale) {
          bookCache.set(id, { book: stale, expiresAtMs });
          for (const w of waiters) w.resolve(stale);
        } else {
          for (const w of waiters) w.reject(unavailable);
        }
        continue;
      }
      const book = resolved.get(id) ?? null;
      bookCache.set(id, { book, expiresAtMs });
      if (book) lastGood.set(id, book);
      else lastGood.delete(id); // authoritative empty/absent -> the ghost dies here
      for (const w of waiters) w.resolve(book);
    }
    trimMap(bookCache);
    trimMap(lastGood);
  } finally {
    inFlightBatches--;
    const next = slotQueue.shift();
    if (next) next();
  }
}

function toTokenBook(r: RawBook): TokenBook | null {
  const asks = normalizeAsks(parseLevels(r.asks));
  const bids = normalizeBids(parseLevels(r.bids));
  // Both sides empty = a dead token, not a real book -> negative-cache it so a known-dead token
  // isn't re-fetched on every poll. A ONE-sided book is still a book (the quote layer prices the
  // empty side as unfillable on its own).
  if (asks.length === 0 && bids.length === 0) return null;
  return {
    tokenId: String(r.asset_id),
    asks,
    bids,
    fetchedAtMs: Date.now(),
    minOrderSize: Number(r.min_order_size) || 0,
    tickSize: Number(r.tick_size) || 0,
  };
}

// Fetch books for the given token ids (deduped). Fresh cache hits (TTL) never touch the network.
// Per-token result: the live book, a stale last-good book (honest fetchedAtMs), or null for a
// known-dead/absent book. Throws ClobUnavailableError ONLY when the CLOB is unreachable AND at
// least one requested token has no cached book to degrade to — so a CLOB outage degrades per-token
// instead of taking every price offline at once.
export async function getBooks(tokenIds: string[]): Promise<Map<string, TokenBook | null>> {
  const unique = [...new Set(tokenIds.filter(Boolean))];
  const out = new Map<string, TokenBook | null>();
  const now = Date.now();
  const misses: string[] = [];
  for (const id of unique) {
    const hit = bookCache.get(id);
    if (hit && hit.expiresAtMs > now) out.set(id, hit.book);
    else misses.push(id);
  }
  await Promise.all(
    misses.map(async (id) => {
      out.set(id, await enqueue(id));
    }),
  );
  return out;
}

// Single-token convenience wrapper (the bet-lock paths quote exactly one side).
export async function getBook(tokenId: string): Promise<TokenBook | null> {
  return (await getBooks([tokenId])).get(tokenId) ?? null;
}
