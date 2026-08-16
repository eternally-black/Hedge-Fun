"use client";

import { memo, startTransition, useCallback, useEffect, useRef, useState } from "react";
import { type Card, type Me } from "../ui";
import { MarketCard, useMarketBet } from "./MarketCard";
import type { BetSide, FeedResponse } from "@/lib/api-types";

// Whatever useApi resolves to — a thrown error carries `.status` (mirrors page.tsx's catch blocks).
type Api = (path: string, init?: RequestInit) => Promise<unknown>;

// Max pages a single loadMore() will skip through when the server hands back an empty page with a
// non-null cursor (a quality-filtered dead zone). Bounds the loop so it can never run away.
const MAX_SKIP_PAGES = 8;

// ============================================================================
// FeedScreen — the post-cap "лента". A TikTok-style vertical scroll-snap of near-50% binary markets
// (crypto-first), cursor-paginated for infinite scroll. Tap a side to bet: same $10 stake as a swipe,
// but POST /api/feed/bet earns NO points (shards still accrue, uncapped). Reuses the deck's card
// helpers (catOf/sideLabels/…); betting is buttons, not gestures.
// ============================================================================
export function FeedScreen({
  api,
  me,
  onRefreshMe,
  onToast,
  onTopup,
}: {
  api: Api;
  me: Me | null;
  onRefreshMe: () => void;
  onToast: (msg: string) => void;
  onTopup: () => void; // open the BalanceSheet top-up when Cash can't cover a stake
}) {
  const [items, setItems] = useState<Card[]>([]);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  // The points-off bet flow: optimistic lock + cash gate + 402/409 handling — see useMarketBet.
  const { placed, placeBet } = useMarketBet({ api, me, onRefreshMe, onToast, onTopup });
  // One shared, gently-ticked clock for all cards' countdowns — 15s is plenty for a scroll feed (the
  // deck ticks per-second because it's a single focused card). Avoids N per-card timers AND keeps
  // Date.now() out of render (impure). Lazy init = correct first paint, no setState-in-effect cascade.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNowMs(Date.now()), 15_000);
    return () => window.clearInterval(t);
  }, []);

  // Refs keep loadMore STABLE (no re-subscribe of the observer) while still reading the latest values.
  const loadingRef = useRef(false);
  const doneRef = useRef(false);
  const cursorRef = useRef<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Fetch the next page(s). Loops past empty-but-not-done pages (server-jumped dead zones) until it
  // appends something or the pool is dry — bounded by MAX_SKIP_PAGES. In-flight guarded so the
  // observer firing repeatedly (or React strict-mode double-mount) can't double-fetch.
  const loadMore = useCallback(async () => {
    if (loadingRef.current || doneRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      for (let i = 0; i < MAX_SKIP_PAGES; i++) {
        const cursor = cursorRef.current;
        const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
        const res = (await api(`/api/feed${q}`)) as FeedResponse;
        cursorRef.current = res.nextCursor;
        let appended = 0;
        startTransition(() => {
          setItems((prev) => {
            const have = new Set(prev.map((c) => c.id));
            const fresh = res.cards.filter((c) => !have.has(c.id));
            appended = fresh.length;
            return fresh.length ? [...prev, ...fresh] : prev;
          });
        });
        if (res.nextCursor === null) { doneRef.current = true; setDone(true); break; }
        if (appended > 0) break; // got cards — stop; the observer will ask again when the user scrolls
      }
    } catch (e) {
      console.error(e);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [api]);

  // Infinite scroll AND first load: observe a sentinel below the last card. On mount the sentinel is
  // already on screen (empty list), so the observer's initial fire pulls page 1 — no separate
  // mount-fetch effect needed (which would be a synchronous setState-in-effect). IntersectionObserver
  // (not a scroll listener) does no per-frame work, and the callback reads everything through refs so
  // the observer is created exactly once.
  useEffect(() => {
    const root = containerRef.current;
    const target = sentinelRef.current;
    if (!root || !target) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) void loadMore(); },
      { root, rootMargin: "600px 0px" }, // prefetch before the sentinel is actually on screen
    );
    io.observe(target);
    return () => io.disconnect();
  }, [loadMore]);

  return (
    <div
      ref={containerRef}
      style={{
        position: "absolute", inset: 0, overflowY: "auto", overflowX: "hidden",
        scrollSnapType: "y proximity", WebkitOverflowScrolling: "touch", // proximity: 2 cards/screen, gentle settle (not one-at-a-time)
      }}
    >
      {items.length === 0 ? (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 28, textAlign: "center" }}>
          <p style={{ color: "var(--muted)", fontSize: 14 }}>
            {done ? "No feed markets right now. Check back after the next batch resolves." : "Loading the feed…"}
          </p>
        </div>
      ) : (
        items.map((card) => (
          <FeedCard key={card.id} card={card} placedSide={placed.get(card.id)} nowMs={nowMs} onBet={placeBet} />
        ))
      )}
      {/* Sentinel: paging trigger + first-load trigger. Always in the tree so the observer has a target. */}
      <div ref={sentinelRef} style={{ height: 1 }} aria-hidden="true" />
      {loading && items.length > 0 ? (
        <div style={{ padding: "16px 0 28px", textAlign: "center", fontSize: 11, color: "var(--muted)" }}>Loading more…</div>
      ) : null}
    </div>
  );
}

// ============================================================================
// FeedCard — one 50%-viewport snap section wrapping the shared MarketCard. Memoized on primitive-ish
// props (card object is stable across pages; placedSide flips only for the bet card; onBet is stable),
// so a /api/me refresh or a bet on another card never re-renders this one. content-visibility lets
// off-screen sections skip layout/paint — the endless-list win.
// ============================================================================
const FeedCard = memo(function FeedCard({
  card,
  placedSide,
  nowMs,
  onBet,
}: {
  card: Card;
  placedSide: BetSide | undefined;
  nowMs: number; // shared feed clock (ticks every 15s) — keeps Date.now() out of render
  onBet: (card: Card, side: BetSide) => void;
}) {
  return (
    <section
      style={{
        // Half the viewport → TWO cards on screen at once (a full-screen single card read as empty).
        // Sized to echo the reveal/result cards. minHeight floors it on short screens.
        height: "50%", minHeight: 300, scrollSnapAlign: "start", padding: "6px 12px",
        contentVisibility: "auto", containIntrinsicSize: "0 360px",
      } as React.CSSProperties}
    >
      <MarketCard card={card} placedSide={placedSide} nowMs={nowMs} onBet={onBet} />
    </section>
  );
});
