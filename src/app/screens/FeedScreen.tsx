"use client";

import { memo, startTransition, useCallback, useEffect, useRef, useState } from "react";
import {
  type Card,
  type Me,
  catOf,
  bgGrad,
  cents,
  usd,
  winPayout,
  countdown,
  sideLabels,
  marketHint,
  displayQuestion,
  isUpDown,
} from "../ui";
import { STAKE_CENTS, DECK_MIN_LEAD_MS } from "@/lib/config";
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
  const [placed, setPlaced] = useState<Map<string, BetSide>>(new Map());
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  // One shared, gently-ticked clock for all cards' countdowns — 15s is plenty for a scroll feed (the
  // deck ticks per-second because it's a single focused card). Avoids N per-card timers AND keeps
  // Date.now() out of render (impure). Lazy init = correct first paint, no setState-in-effect cascade.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNowMs(Date.now()), 15_000);
    return () => window.clearInterval(t);
  }, []);

  // Refs keep loadMore / placeBet STABLE (no re-subscribe of the observer, no re-keyed cards) while
  // still reading the latest values — the meRef / topping-guard pattern from page.tsx.
  const meRef = useRef<Me | null>(me);
  useEffect(() => { meRef.current = me; }, [me]);
  const placedRef = useRef(placed);
  useEffect(() => { placedRef.current = placed; }, [placed]);
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

  // Place a points-off feed bet. Optimistic: lock the card immediately, then POST. Cash gate +
  // rollback mirror the deck's act() (page.tsx). Reads me/placed via refs so the callback is stable.
  const placeBet = useCallback(
    (card: Card, side: BetSide) => {
      if (placedRef.current.has(card.id)) return; // already bet this card
      const m = meRef.current;
      if (m && m.cashCents < m.stakeCents) {
        onToast("No free cash — top up to keep going");
        onTopup();
        return;
      }
      setPlaced((prev) => new Map(prev).set(card.id, side));
      api("/api/feed/bet", { method: "POST", body: JSON.stringify({ marketId: card.id, side }) })
        .then(() => onRefreshMe())
        .catch((e) => {
          const status = (e as { status?: number }).status;
          if (status === 409) { void onRefreshMe(); return; } // already bet / expired — leave it locked
          // Roll back the optimistic lock so the user can retry (or top up).
          setPlaced((prev) => { const n = new Map(prev); n.delete(card.id); return n; });
          if (status === 402) { onToast("No free cash — top up to keep going"); onTopup(); }
          else console.error(e);
        });
    },
    [api, onRefreshMe, onToast, onTopup],
  );

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
// FeedCard — one full-viewport snap section with a tappable market card. Memoized on primitive-ish
// props (card object is stable across pages; placedSide flips only for the bet card; onBet is
// stable), so a /api/me refresh or a bet on another card never re-renders this one. content-visibility
// lets off-screen sections skip layout/paint — the endless-list win.
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
  const cat = catOf(card);
  const labels = sideLabels(card);
  const hint = marketHint(card);
  const cd = countdown(card.resolutionDeadline, nowMs);
  const expired = new Date(card.resolutionDeadline).getTime() - nowMs <= DECK_MIN_LEAD_MS;

  return (
    <section
      style={{
        // Half the viewport → TWO cards on screen at once (a full-screen single card read as empty).
        // Sized to echo the reveal/result cards. minHeight floors it on short screens.
        height: "50%", minHeight: 300, scrollSnapAlign: "start",
        display: "flex", alignItems: "stretch", padding: "6px 12px",
        contentVisibility: "auto", containIntrinsicSize: "0 360px",
      } as React.CSSProperties}
    >
      <div style={{ position: "relative", flex: 1, borderRadius: 22, overflow: "hidden", background: "var(--panel2)", border: "1px solid var(--line)", boxShadow: "0 18px 40px -20px rgba(0,0,0,.7)" }}>
        <div style={{ position: "absolute", inset: 0, background: bgGrad(cat.color) }} />
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", padding: "14px 15px" }}>
          {/* category + countdown */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, background: "rgba(0,0,0,.4)", backdropFilter: "blur(6px)", padding: "4px 9px", borderRadius: 18 }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: cat.color, boxShadow: `0 0 8px ${cat.color}` }} />
              <span style={{ fontSize: 9, letterSpacing: ".12em", textTransform: "uppercase", fontWeight: 700, color: "#fff" }}>{cat.label}</span>
            </div>
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 5, background: "rgba(0,0,0,.4)", backdropFilter: "blur(6px)", padding: "4px 9px", borderRadius: 18, border: `1px solid ${cd.urgent ? "color-mix(in srgb,var(--no) 60%,transparent)" : "transparent"}` }}>
              <span style={{ fontSize: 11 }}>⏱</span>
              <span style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 12, color: cd.urgent ? "var(--no)" : "#fff" }}>{cd.text}</span>
            </div>
          </div>

          {/* question — compact (≈ reveal card proportions), clamped so two cards stay balanced */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", padding: "8px 0", minHeight: 0 }}>
            <div style={{ fontFamily: "var(--df)", fontSize: 20, lineHeight: 1.08, letterSpacing: ".2px", color: "#fff", textShadow: "0 2px 16px rgba(0,0,0,.5)", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" } as React.CSSProperties}>{displayQuestion(card)}</div>
            {isUpDown(card)
              ? <div style={{ marginTop: 6, fontSize: 11, color: "rgba(255,255,255,.6)", lineHeight: 1.3 }}>{cd.relText}</div>
              : hint ? <div style={{ marginTop: 6, fontSize: 11, color: "rgba(255,255,255,.6)", lineHeight: 1.3, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" } as React.CSSProperties}>{hint}</div> : null}
          </div>

          {/* odds split */}
          <div style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--nf)", fontWeight: 700, fontSize: 12, marginBottom: 5 }}>
              <span style={{ color: "var(--no)" }}>{labels.no} {cents(card.noPriceBp)}</span>
              <span style={{ color: "var(--yes)" }}>{cents(card.yesPriceBp)} {labels.yes}</span>
            </div>
            <div style={{ display: "flex", height: 10, borderRadius: 6, overflow: "hidden", background: "rgba(0,0,0,.4)" }}>
              <div style={{ width: `${card.noPriceBp / 100}%`, background: "linear-gradient(90deg,color-mix(in srgb,var(--no) 60%,#000),var(--no))" }} />
              <div style={{ flex: 1, background: "linear-gradient(90deg,var(--yes),color-mix(in srgb,var(--yes) 60%,#000))" }} />
            </div>
          </div>

          {/* action row: two tap-to-bet buttons, or a locked banner once placed */}
          {placedSide ? (
            <LockedBanner card={card} side={placedSide} labels={labels} />
          ) : (
            <div style={{ display: "flex", alignItems: "stretch", gap: 8 }}>
              <BetButton label={labels.no} payout={winPayout(card.noPriceBp)} color="var(--no)" disabled={expired} onClick={() => onBet(card, "NO")} />
              <BetButton label={labels.yes} payout={winPayout(card.yesPriceBp)} color="var(--yes)" disabled={expired} onClick={() => onBet(card, "YES")} />
            </div>
          )}
          <div style={{ textAlign: "center", marginTop: 8, fontSize: 10, color: "rgba(255,255,255,.5)", letterSpacing: ".02em" }}>
            {expired ? "Resolving — closed for new calls" : `${usd(STAKE_CENTS)} · no points, shards on wins`}
          </div>
        </div>
      </div>
    </section>
  );
});

function BetButton({ label, payout, color, disabled, onClick }: { label: string; payout: number; color: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        flex: 1, minWidth: 0, padding: "9px 8px", borderRadius: 14, font: "inherit", cursor: disabled ? "default" : "pointer",
        background: `color-mix(in srgb,${color} 16%,transparent)`, border: `1.5px solid color-mix(in srgb,${color} 50%,transparent)`,
        color, display: "flex", flexDirection: "column", alignItems: "center", gap: 1, opacity: disabled ? 0.5 : 1,
      }}
    >
      <span style={{ fontFamily: "var(--df)", fontSize: 16, lineHeight: 1, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      <span style={{ fontSize: 10, color: "rgba(255,255,255,.7)" }}>to win <span style={{ fontFamily: "var(--nf)", fontWeight: 700, color }}>${payout}</span></span>
    </button>
  );
}

function LockedBanner({ card, side, labels }: { card: Card; side: BetSide; labels: { yes: string; no: string } }) {
  const color = side === "YES" ? "var(--yes)" : "var(--no)";
  const label = side === "YES" ? labels.yes : labels.no;
  const payout = winPayout(side === "YES" ? card.yesPriceBp : card.noPriceBp);
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "13px 12px", borderRadius: 16, background: `color-mix(in srgb,${color} 18%,transparent)`, border: `1.5px solid color-mix(in srgb,${color} 55%,transparent)` }}>
      <span style={{ fontSize: 16, color }}>✓</span>
      <span style={{ fontSize: 13, color: "#fff" }}>
        You&apos;re in on <span style={{ fontFamily: "var(--df)", color }}>{label}</span> — <span style={{ fontFamily: "var(--nf)", fontWeight: 700, color }}>${payout}</span> to win
      </span>
    </div>
  );
}
