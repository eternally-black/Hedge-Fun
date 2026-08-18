"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { usePrivy } from "@privy-io/react-auth";
import { useApi } from "./useApi";
import { DeckCard, CardPreview, type SwipeAction } from "./DeckCard";
import { Hud } from "./screens/Hud";
import { BottomNav } from "./screens/BottomNav";
import { Onboarding } from "./screens/Onboarding";
import { GmScreen } from "./screens/GmScreen";
import { VaultScreen } from "./screens/VaultScreen";
import { InviteScreen } from "./screens/InviteScreen";
import { ProfileScreen } from "./screens/ProfileScreen";
import { HistorySheet } from "./screens/HistorySheet";
import { StakeSheet } from "./screens/StakeSheet";
import { BalanceSheet } from "./screens/BalanceSheet";
import { NotificationsScreen } from "./screens/NotificationsScreen";
import { HedgeScreen } from "./screens/HedgeScreen";
import { RevealOverlay } from "./screens/RevealOverlay";
import { type Card, type Me, type Screen } from "./ui";
import { useRealCtx } from "./useRealCtx";
import { APP_SURFACE_ID } from "./appSurface";
import { placeRealOrder } from "@/lib/real-client";
import { DECK_MIN_LEAD_MS, QUOTE_POLL_MS, STAKE_CENTS, REAL_BALANCE_POLL_MS } from "@/lib/config";
import type { QuotesResponse, ResultRow, ResultsResponse, SwipeResponse } from "@/lib/api-types";

const PRIVY_ON = !!process.env.NEXT_PUBLIC_PRIVY_APP_ID;

// The feed is only reachable AFTER the swipe cap, so lazy-load it (next/dynamic, ssr:false) — its
// component + paging logic stay out of the initial deck bundle every user pays for on first paint.
const FeedScreen = dynamic(() => import("./screens/FeedScreen").then((m) => m.FeedScreen), { ssr: false });

// Stealth referral code readers. The middleware sets a non-httpOnly `hf_ref` cookie on a
// /r/<code> click and redirects to a clean "/" (no ?ref= in the URL). We read it from the cookie,
// falling back to the localStorage mirror (survives Safari ITP / Brave cookie purges). Module
// scope: pure, no React state — safe to call from effects/handlers without re-creating per render.
function readRefCookie(): string | null {
  const m = document.cookie.match(/(?:^|;\s*)hf_ref=([^;]+)/);
  return m ? decodeURIComponent(m[1]!) : null;
}
function readRef(): string | null {
  const c = readRefCookie();
  if (c) return c;
  try { return localStorage.getItem("hf_ref"); } catch { return null; }
}

// A card is "fresh" while it has more than the lead buffer (DECK_MIN_LEAD_MS) left before resolution.
// Stale cards are pruned from the deck so a swipe never lands on a near-resolved (⏱ -> 0:00) market.
function isFresh(c: Card, nowMs: number): boolean {
  return new Date(c.resolutionDeadline).getTime() - nowMs > DECK_MIN_LEAD_MS;
}

export default function Home() {
  if (!PRIVY_ON) return <ConfigNotice />;
  return <App />;
}

function ConfigNotice() {
  return (
    <Frame>
      <div style={{ padding: 28, textAlign: "center", marginTop: 120 }}>
        <div style={{ fontFamily: "var(--df)", fontSize: 40 }}>Hedge Fun</div>
        <p style={{ color: "var(--muted)", marginTop: 12 }}>
          Set <code>NEXT_PUBLIC_PRIVY_APP_ID</code> and <code>PRIVY_APP_SECRET</code> in <code>.env.local</code>.
        </p>
      </div>
    </Frame>
  );
}

function App() {
  const { ready, authenticated, login, logout } = usePrivy();
  const api = useApi();
  const [me, setMe] = useState<Me | null>(null);
  const [deck, setDeck] = useState<Card[]>([]);
  const [screen, setScreen] = useState<Screen>("deck");
  // One-shot: true only for the moment the user JUST spent their last swipe this session. Gates the
  // "Deck's done → Feed" hand-off panel so it shows exactly once; every other time the deck is locked
  // (relogin, post-reveal, tapping a disabled Deck tab) we route straight to the feed, no panel.
  const [justExhausted, setJustExhausted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pop, setPop] = useState<{ amt: number; color: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // Opened from the STAKE chip on the top card. Real mode only — in paper the stake is a game rule
  // (STAKE_CENTS) that a player does not get to set, so the chip there stays inert text.
  const [stakeOpen, setStakeOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [balanceOpen, setBalanceOpen] = useState(false);
  // Results reveal: the rows to play, or null when closed. Opened by the daily-open ritual (unseen
  // results on auth) and by "Replay" from the inbox. `revealMode` controls where closing it leads:
  // a daily-ritual reveal chains forward (GM if not checked in, else deck); a replay just returns to
  // the deck (it's a re-watch, not the open sequence).
  const [reveal, setReveal] = useState<ResultRow[] | null>(null);
  const revealMode = useRef<"ritual" | "replay">("ritual");
  // Latest `me` mirrored into a ref so event handlers (e.g. exitReveal) can read the CURRENT value
  // without depending on `me` — that keeps those callbacks stable across the frequent me refreshes.
  // Written in an effect (after commit), not during render, so it's safe under concurrent rendering.
  const meRef = useRef<Me | null>(null);
  useEffect(() => { meRef.current = me; }, [me]);
  // First-paint gate: stay on the spinner until me + results have loaded and we've DECIDED whether
  // the reveal plays. This prevents the deck flashing for a frame before the reveal floats up — the
  // very first content frame is already the right screen (reveal or deck), never an intermediate.
  const [booted, setBooted] = useState(false);
  // REAL mode. `me.real.mode` is the server's answer and already accounts for missing or stale
  // consent, so the client never has to re-derive eligibility — it just renders what it is told.
  const realMode = me?.real.mode === "REAL";
  // The number the card states and derives its payouts from. In real mode it is the account's own
  // setting; paper keeps the fixed game rule. Falls back to STAKE_CENTS only pre-boot, when there is
  // no `me` yet and the card is not swipeable anyway.
  const effectiveStakeCents = realMode ? (me?.real.stakeCents ?? STAKE_CENTS) : STAKE_CENTS;
  const { ctx: realCtx } = useRealCtx(me);
  // Refs, not values, for the same reason meRef exists here: the swipe callback must keep a stable
  // identity across the frequent /api/me refreshes, or the keyed DeckCard is handed new props every
  // refresh and re-mounts mid-gesture.
  const realCtxRef = useRef(realCtx);
  realCtxRef.current = realCtx;
  const realModeRef = useRef(realMode);
  realModeRef.current = realMode;
  // Spendable pUSD, read from chain via /api/real/wallet. Only fetched in real mode: paper must not
  // pay for an RPC round-trip it never shows.
  const [realPusdMicro, setRealPusdMicro] = useState<string | null>(null);
  const refreshRealBalance = useCallback(async () => {
    try {
      const r = (await api("/api/real/wallet")) as { pusdMicro?: string | null };
      setRealPusdMicro(r.pusdMicro ?? null);
    } catch {
      setRealPusdMicro(null); // an RPC hiccup shows "—", never a misleading $0.00
    }
  }, [api]);

  // Real balance follows the MODE, not the screen: the HUD shows it everywhere once real is on, so
  // it is fetched when the mode turns on and after each real order. Paper mode never fetches.
  useEffect(() => {
    if (!realMode) { setRealPusdMicro(null); return; }
    void refreshRealBalance();
    // The HUD states this number on every screen, so it has to become true on its own — a deposit
    // that only appears after a manual reload reads as a deposit that did not arrive. One poller,
    // here, rather than one per screen that happens to care.
    //
    // Gated on visibility: a hidden tab is an RPC read per interval for a number nobody is looking
    // at. Coming back re-reads immediately, which is also the exact moment someone returns from the
    // wallet or exchange they just sent from.
    let timer: number | undefined;
    const stop = () => window.clearInterval(timer);
    const start = () => {
      stop();
      timer = window.setInterval(() => void refreshRealBalance(), REAL_BALANCE_POLL_MS);
    };
    const onVis = () => {
      if (document.hidden) return stop();
      void refreshRealBalance();
      start();
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
    };
  }, [realMode, refreshRealBalance]);
  // Every card id this session has already put in front of the user. The refill dedupes against
  // THIS, not against the current deck: a skipped card is gone from the deck, so dedupe-by-deck let
  // the server hand it straight back — and it does hand it back, because /api/skip records only a
  // daily counter, not WHICH market was skipped. Harmless in paper (the pool is ~67k markets, so a
  // repeat is a coincidence); in real mode the deck is limited to markets with a fresh CLOB book,
  // which is ~90 at a time, so the same card returned within seconds, repeatedly.
  // Session-scoped on purpose: a skip is "not now", not "never again" — a reload may re-serve it.
  const served = useRef<Set<string>>(new Set());
  const remember = useCallback((cards: Card[]) => {
    for (const c of cards) served.current.add(c.id);
    return cards;
  }, []);
  const ritualDone = useRef(false); // run the auth→reveal→gm sequence once per load, not on every refresh
  const topping = useRef(false);
  const popTimer = useRef<number | undefined>(undefined);
  const toastTimer = useRef<number | undefined>(undefined);

  // Each card owns its own countdown tick now (see DeckCard.useCountdown), so the clock no
  // longer re-renders this whole component every second — only the visible cards refresh.
  useEffect(() => () => { window.clearTimeout(popTimer.current); window.clearTimeout(toastTimer.current); }, []);

  // Full reload: stats + a fresh deck. Used on mount / GM / dev-reset — NOT after a swipe.
  const refresh = useCallback(async () => {
    const [m, d] = await Promise.all([api("/api/me"), api("/api/deck")]);
    setMe(m);
    setDeck(remember(d.cards as Card[]));
  }, [api, remember]);

  // Stats only — never touches the deck. After a swipe we must NOT re-fetch /api/deck: it's
  // re-shuffled with a fresh seed each call, so replacing the deck would make a DIFFERENT card
  // (not the previewed one) snap into the top slot. Local advance() handles the deck; this just
  // updates points/shards/balance/skip counters.
  const refreshMe = useCallback(async () => {
    setMe(await api("/api/me"));
  }, [api]);

  // On a /r/<code> click the middleware set the hf_ref cookie. Here (once per load) we (1) mirror
  // it into localStorage so attribution survives a cookie purge (Safari ITP / Brave), and (2) log
  // the click from the BROWSER to /api/ref-click — the server hashes our real IP/UA for the
  // cross-browser fallback. Logging client-side (not from middleware) because a server-to-self
  // fetch in self-hosted Next middleware doesn't round-trip. Guarded by a sessionStorage flag so
  // we log each click once, not on every page load. advanced-init-once.
  useEffect(() => {
    const code = readRefCookie();
    if (!code) return;
    try { localStorage.setItem("hf_ref", code); } catch { /* storage blocked */ }
    try {
      if (sessionStorage.getItem("hf_ref_logged") !== code) {
        void fetch("/api/ref-click", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code }),
        }).then(() => sessionStorage.setItem("hf_ref_logged", code)).catch(() => {});
      }
    } catch { /* storage blocked — skip the once-guard, still attempt below is fine */ }
  }, []);

  // Boot: one coherent first-load sequence per auth. We gate the first content frame on me + results
  // (the two things that decide WHAT to show), load the deck in parallel (it's ready by the time the
  // reveal finishes, or by deck-paint if there's no reveal), then lift the spinner. No intermediate
  // frames: the reveal decision is made before `booted` flips, so the deck never flashes first.
  useEffect(() => {
    if (!authenticated || ritualDone.current) return;
    ritualDone.current = true;

    // Referral capture only — NOT the GM mark. App-open must never count as a check-in; the day is
    // marked only when the user taps Claim on the GM screen. capture-ref is idempotent, so it's safe
    // to fire every open; it preserves attribution even for a user who never taps GM.
    const ref = readRef();
    const capturePath = ref ? `/api/capture-ref?ref=${encodeURIComponent(ref)}` : "/api/capture-ref";
    api(capturePath, { method: "POST" }).catch(() => { /* idempotent; the GM tap also captures */ });

    // Deck loads in the background — NOT awaited by the gate (a user with unseen results watches the
    // reveal while the deck arrives; a user without results waits on the spinner the deck-fetch fills).
    api("/api/deck").then((d) => setDeck(remember((d as { cards: Card[] }).cards))).catch(console.error);

    // Gate: me + results in parallel. Decide the daily-open ritual, set state, THEN unspin — so the
    // first frame is the right screen, no flash. Ritual (matches Android once it ships the same flags):
    //   • brand-new user      → straight to the deck, ZERO popups (feel the core loop first).
    //   • unseen results      → play the reveal (it chains forward to GM on finish/skip).
    //   • else not GM'd today → open GM (the once-a-day check-in is the open ritual).
    //   • else (checked in)   → deck.
    Promise.all([api("/api/me"), api("/api/results")])
      .then(([m, r]) => {
        const me = m as Me;
        setMe(me);
        if (me.isNewUser) return; // new user: deck (default screen), no reveal, no GM
        const unseen = (r as ResultsResponse).rows.filter((row) => !row.seen);
        if (unseen.length) { revealMode.current = "ritual"; setReveal(unseen); }
        else if (!me.loginMarkedToday) setScreen("gm");
      })
      .catch(console.error)
      .finally(() => setBooted(true));
  }, [authenticated, api, remember]);

  // Preload-ahead: refill well before the deck runs dry (threshold 8, not 1), so a fresh card is
  // always buffered behind the current one. `topping` dedupes so only one fetch is in flight.
  const topUpIfLow = useCallback(
    async (remaining: number) => {
      if (remaining > 8 || topping.current) return;
      topping.current = true;
      try {
        const d: { cards: Card[] } = await api("/api/deck");
        setDeck((cur) => [...cur, ...remember(d.cards.filter((c) => !served.current.has(c.id)))]);
      } catch (e) {
        console.error(e);
      } finally {
        topping.current = false;
      }
    },
    [api, remember],
  );

  // Live freshness prune: every few seconds drop cards that aged within the lead buffer, so a card
  // the user is slowly reaching (or sitting on) never decays to ⏱ -> 0:00 at the top — the next fresh
  // card rises in its place, and a drained deck triggers a refill. Cheap: only re-renders when a card
  // actually crosses the line (otherwise the array is returned unchanged → no state update).
  useEffect(() => {
    const id = window.setInterval(() => {
      setDeck((d) => {
        const now = Date.now();
        const fresh = d.filter((c) => isFresh(c, now));
        if (fresh.length === d.length) return d;
        void topUpIfLow(fresh.length);
        return fresh;
      });
    }, 5000);
    return () => window.clearInterval(id);
  }, [topUpIfLow]);

  // Live quote on the TOP card (D10 Slice B). A CLOB book churns roughly every 5s, so the price a
  // card was dealt with is stale within seconds — and the scenario that matters is exactly the one
  // where the user sits on a card deliberating. We re-poll only the card they can act on: a
  // next-up card's price is irrelevant until it surfaces, and it gets a live quote the moment it
  // does (this effect re-arms on topId). Paused when the tab is hidden — no radio spend on a deck
  // nobody is looking at, and the first poll on return re-syncs before any swipe can land.
  const topId = deck[0]?.id;
  useEffect(() => {
    if (!topId || screen !== "deck") return;
    let alive = true;
    const poll = async () => {
      if (document.hidden) return;
      // Cap spent -> the deck view is swapped for the feed, so the top card isn't on screen. Read it
      // from meRef so this effect doesn't re-arm on every /api/me refresh (which would restart the
      // interval and, with it, the cadence the user is watching).
      const m = meRef.current;
      if (m && !m.dev && m.swipes.used >= m.swipes.cap) return;
      try {
        // The stake goes WITH the request: a quote is a walk of the book, so its price only means
        // anything for a size. Omitting it made the route fall back to the paper $10 while a real
        // order was $1 — a deeper walk, a worse price, and in real mode that number is the bound the
        // order gets bound to. Conservative, so nothing was promised that could not be honoured, but
        // the card understated its own payout and priced a size nobody was about to trade.
        const r = (await api(
          `/api/quotes?ids=${encodeURIComponent(topId)}&stake=${effectiveStakeCents}`,
        )) as QuotesResponse;
        const q = r.quotes.find((x) => x.marketId === topId);
        if (!alive || !q || q.yesPriceBp == null || q.noPriceBp == null) return;
        // Patch prices in place — never reorder or drop, or the card would move under the thumb.
        setDeck((d) =>
          d.map((c) =>
            c.id === topId && (c.yesPriceBp !== q.yesPriceBp || c.noPriceBp !== q.noPriceBp)
              ? { ...c, yesPriceBp: q.yesPriceBp!, noPriceBp: q.noPriceBp! }
              : c,
          ),
        );
      } catch {
        // A failed poll is a no-op: keep showing the last real price. The swipe re-quotes anyway,
        // and the seen-vs-executed guard catches anything that drifted while we were blind.
      }
    };
    void poll();
    const id = window.setInterval(() => void poll(), QUOTE_POLL_MS);
    const onVis = () => { if (!document.hidden) void poll(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [topId, screen, api, effectiveStakeCents]);

  const flashPop = useCallback((amt: number, color: string) => {
    setPop({ amt, color });
    window.clearTimeout(popTimer.current);
    popTimer.current = window.setTimeout(() => setPop(null), 700);
  }, []);

  const flashToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  }, []);

  // Act on the top card: YES/NO post a bet, SKIP posts to /api/skip (always free + unlimited —
  // the shard-sink was dropped, so a skip never fails/402s). The card advances; a swipe-409
  // (already bet) advances too. Backend contracts (cents, named-binary, points/shards) unchanged.
  const act = useCallback(
    (card: Card, action: SwipeAction) => {
      const advance = () =>
        setDeck((d) => {
          // Drop the acted card AND any now-stale cards, so the next one up is always fresh.
          const now = Date.now();
          const next = d.filter((c) => c.id !== card.id && isFresh(c, now));
          void topUpIfLow(next.length);
          return next;
        });
      // Skips are always free + unlimited now — no client gate (the server never 402s a skip).
      // Cash gate: a YES/NO bet needs >= one stake of free Cash. Block BEFORE the optimistic advance
      // so the card isn't lost — it stays so the user can top up and retry. Read the gate from
      // meRef.current (not `me`) so this callback stays stable across the frequent /api/me refreshes
      // — otherwise act + handleAction would get a new identity every refresh and re-key the DeckCard.
      const m = meRef.current;
      // The cash gate is PAPER's. Real money is bounded on chain and by the server's own quote, and
      // meRef carries virtual cents that say nothing about pUSD — applying it in real mode would
      // block a funded account because its play balance ran out.
      if (!realModeRef.current && action !== "SKIP" && m && m.cashCents < m.stakeCents) {
        flashToast("No free cash left");
        return;
      }
      if (realModeRef.current && action !== "SKIP" && !realCtxRef.current?.depositWalletAddress) {
        flashToast("Finish real-money setup in your profile first");
        return;
      }
      // OPTIMISTIC: advance the deck immediately so the next card rises in sync with the fly-out
      // animation (the gesture already committed). The network call runs in the background — we
      // do NOT block the UI on it, which is what made advancing feel laggy/network-coupled.
      advance();
      flashPop(action === "SKIP" ? 0 : 1, action === "SKIP" ? "var(--skip)" : action === "YES" ? "var(--yes)" : "var(--no)");

      // Echo the price the user was LOOKING AT for the side they picked. The server re-quotes the
      // live book and, if it moved against them beyond tolerance, refuses instead of booking a worse
      // price silently (D10 Slice B). With the top card polling every few seconds this is normally
      // the same book the server reads, so the rejection path is a genuine-move edge, not routine.
      // A skip is a skip in both economies. A YES/NO in REAL mode goes through the two-phase order
      // protocol instead of the paper ledger: intent (server derives the params) -> device signs
      // exactly those -> submit. Same gesture, same optimistic advance; the money is the difference.
      const quotedPriceBp = action === "YES" ? card.yesPriceBp : card.noPriceBp;
      const req =
        action === "SKIP"
          ? api("/api/skip", { method: "POST" })
          : realModeRef.current && realCtxRef.current
            ? placeRealOrder(api, realCtxRef.current, {
                marketId: card.id,
                side: action,
                dir: "ENTRY",
                quotedPriceBp,
              }).then((r) => {
                void refreshRealBalance(); // the debit already happened on chain
                return r as unknown;
              })
            : api("/api/swipe", {
                method: "POST",
                body: JSON.stringify({ marketId: card.id, side: action, quotedPriceBp }),
              });
      req
        .then((r) => {
          refreshMe(); // stats only (points/shards/balance/skip counter); never the deck
          // The swipe that spends the LAST point swipe (count == cap, not over) is the moment we hand
          // off to the feed — arm the one-shot panel. (Skips don't count; dev never caps.)
          // The cap handoff is a PAPER concept: the swipe counter and the feed panel belong to the
          // play economy, and the real path returns an order result with none of those fields.
          if (action !== "SKIP" && !realModeRef.current) {
            const resp = r as SwipeResponse;
            const cap = meRef.current?.swipes.cap ?? 0;
            if (!resp.overCap && cap > 0 && resp.swipeCountToday >= cap) setJustExhausted(true);
          }
        })
        .catch((e) => {
          const status = (e as { status?: number }).status;
          // 403 = daily swipe cap hit (raced past the client gate). The bet wasn't stored;
          // refreshMe pulls used>=cap, which flips capReached and shows the limit screen.
          if (status === 403) { flashToast("Daily limit reached — back at 00:00 UTC"); void refreshMe(); }
          // 402 = no free cash for a swipe (we pre-gate, so this means a race). The swipe tx rolled
          // back (no bet row), so the market re-enters a future deck — the card isn't lost. Skips
          // never 402 anymore (always free).
          else if (status === 402) { flashToast("No free cash left"); void refreshMe(); }
          // 409 price_moved = the book moved against the user between the quote they saw and the
          // re-quote at lock time. Nothing was stored, so UNDO the optimistic advance: put the card
          // back on top carrying the FRESH price, and let them decide again at the honest number.
          // Every other 409 (already bet / expired / untradable) is terminal — the card stays gone.
          else if (status === 409) {
            const body = (e as { body?: { error?: string; freshPriceBp?: number } }).body;
            if (body?.error === "price_moved" && typeof body.freshPriceBp === "number") {
              const fresh = body.freshPriceBp;
              setDeck((d) => {
                if (d.some((c) => c.id === card.id)) return d; // already back (double-tap race)
                const restored: Card = action === "YES"
                  ? { ...card, yesPriceBp: fresh }
                  : { ...card, noPriceBp: fresh };
                return [restored, ...d];
              });
              flashToast("Price moved — swipe again to confirm");
            }
            // The wallet has no trading permissions yet, so the intent refused before anything was
            // signed or spent. Same treatment as a moved price: the card comes back, because
            // nothing happened to it — and the toast names the one place that fixes it. Without
            // this branch the card simply vanished and the swipe looked like it had worked.
            else if (body?.error === "approvals_required") {
              setDeck((d) => (d.some((c) => c.id === card.id) ? d : [card, ...d]));
              flashToast("Activate trading in Profile first");
            }
          }
          else console.error(e);
        });
    },
    [api, refreshMe, topUpIfLow, flashPop, flashToast, refreshRealBalance],
  );

  // Stable handlers for the keyed DeckCard so it isn't handed new function props each render.
  // handleAction reads the current top via a ref (kept in sync below).
  const topRef = useRef<Card | undefined>(undefined);
  // Keep the gesture handler's "current top" in sync AFTER commit (not via a render-time ref write).
  useEffect(() => { topRef.current = deck[0]; }, [deck]);
  const handleAction = useCallback((a: SwipeAction) => { if (topRef.current) act(topRef.current, a); }, [act]);
  const noop = useCallback(() => {}, []); // tap-for-detail: sheet TODO

  const gm = useCallback(async () => {
    setBusy(true);
    try {
      const ref = readRef();
      await api(ref ? `/api/login-mark?ref=${encodeURIComponent(ref)}` : "/api/login-mark", { method: "POST" });
      // Stats only — GM check-in updates streak/points/login state but must NOT re-fetch /api/deck:
      // it's re-shuffled with a fresh seed each call, so swapping the deck here would change which
      // card sits on top (same rationale as the post-swipe path). refreshMe leaves the deck intact.
      await refreshMe();
    } finally {
      setBusy(false);
    }
  }, [api, refreshMe]);

  // Spend 1 artifact to revive a burned (recoverable) streak — the recovery flow now lives on the GM
  // screen (was in the Vault). refreshMe repaints streak state + artifact balance; deck is untouched.
  const revive = useCallback(async () => {
    setBusy(true);
    try {
      await api("/api/recover", { method: "POST" });
      await refreshMe();
    } finally {
      setBusy(false);
    }
  }, [api, refreshMe]);

  // Stable nav callbacks so memo'd Hud/BottomNav don't re-render on unrelated state changes.
  const goVault = useCallback(() => setScreen("vault"), []);
  const goGmScreen = useCallback(() => setScreen("gm"), []);
  const openHistory = useCallback(() => setHistoryOpen(true), []);
  const closeHistory = useCallback(() => setHistoryOpen(false), []);
  const openBalance = useCallback(() => setBalanceOpen(true), []);
  const closeBalance = useCallback(() => setBalanceOpen(false), []);
  const goDeck = useCallback(() => setScreen("deck"), []);
  const goNotifs = useCallback(() => setScreen("notifications"), []);
  // Nav from the bottom bar: consume the one-shot hand-off, so after the first time the deck is
  // locked every further navigation lands on the feed (never the panel again).
  const navTo = useCallback((s: Screen) => { setJustExhausted(false); setScreen(s); }, []);
  // The hand-off panel's CTA: into the feed, one-shot consumed.
  const enterFeedFromCap = useCallback(() => { setJustExhausted(false); setScreen("feed"); }, []);

  // Method-scoped login: a single loginMethods entry makes Privy skip the picker and go straight to
  // that method (email → email entry, twitter → OAuth redirect). Stable so Onboarding gets the same
  // refs each render.
  const loginTwitter = useCallback(() => login({ loginMethods: ["twitter"] }), [login]);
  const loginEmail = useCallback(() => login({ loginMethods: ["email"] }), [login]);

  // Sign out: clear local account state so a re-login boots fresh (no previous user's me/deck/reveal
  // flashing under the spinner), reset the boot gate, then end the Privy session. `authenticated`
  // flips false → the app falls back to Onboarding.
  const doLogout = useCallback(async () => {
    setMe(null);
    setDeck([]);
    served.current.clear(); // a reset re-deals every market; keeping the memory would hide them all
    setReveal(null);
    setScreen("deck");
    setBooted(false);
    ritualDone.current = false;
    await logout().catch(console.error);
  }, [logout]);

  // Opening the inbox clears the unread badge optimistically; the NotificationsScreen POSTs
  // /api/results/seen, and the next /api/me confirms unreadResults=0.
  const markResultsSeen = useCallback(() => {
    setMe((m) => (m && m.unreadResults ? { ...m, unreadResults: 0 } : m));
  }, []);

  // Where a closed reveal leads. A daily-ritual reveal chains forward to GM, but ONLY if the user
  // hasn't checked in today — GM is once a day; otherwise the deck. A replay just returns to the deck.
  // Reads the live `me` via meRef so this stays a stable callback (no [me] dep, no churn per swipe).
  const exitReveal = useCallback(() => {
    const m = meRef.current;
    if (revealMode.current === "ritual" && m && !m.loginMarkedToday) setScreen("gm");
    else setScreen("deck");
  }, []);

  // Reveal exits. Watching through to summary "clears unread" (design §4): mark seen on the SERVER so
  // the badge stays gone after the next /api/me. Skip is the safety net — it does NOT mark seen
  // (unwatched results stay badged in the bell), only closes the overlay. Both refresh /api/me so
  // balance/shards/unread reflect the server. Replay (from inbox) re-opens all rows as a re-watch.
  const finishReveal = useCallback(() => {
    setReveal(null);
    markResultsSeen();
    api("/api/results/seen", { method: "POST" }).catch(() => { /* badge re-syncs from /api/me */ });
    exitReveal();
    void refreshMe();
  }, [api, markResultsSeen, refreshMe, exitReveal]);
  const skipReveal = useCallback(() => {
    setReveal(null);
    exitReveal();
    void refreshMe(); // badge persists — unwatched results stay unread (the safety net)
  }, [refreshMe, exitReveal]);
  const replayReveal = useCallback(() => {
    api("/api/results")
      .then((r) => { revealMode.current = "replay"; setReveal((r as ResultsResponse).rows); })
      .catch(console.error);
  }, [api]);

  if (!ready) return <Frame><Spinner /></Frame>;
  if (!authenticated) return <Frame><Onboarding onTwitter={loginTwitter} onEmail={loginEmail} /></Frame>;
  // Authed but not booted: hold the spinner until me + results are loaded and the reveal decision is
  // made. The first content frame below is then the correct screen (reveal or deck), never a flash.
  if (!booted) return <Frame><Spinner /></Frame>;

  const top = deck[0];
  const next = deck[1];
  const equippedSkin = me?.skins.equipped ?? "classic"; // drives every deck card's background
  // Hard daily cap: once a non-dev user hits the swipe cap, stop the deck and show the
  // "come back tomorrow" screen. Dev accounts swipe unlimited (and have a deck reset).
  const capReached = !!me && !me.dev && me.swipes.used >= me.swipes.cap;
  const deckLocked = capReached; // non-dev who spent the cap: the deck is done until 00:00 UTC
  // Once the deck is locked the FEED is home. We render it in the deck slot too (so relogin / the
  // post-reveal landing / a tap on a stale Deck route all show the feed), EXCEPT the one-shot
  // just-exhausted moment, which shows the hand-off panel. Pure render derivation — no redirect
  // effect, so there's no one-frame flash of the deck before bouncing to the feed.
  const effectiveScreen: Screen = screen === "deck" && deckLocked && !justExhausted ? "feed" : screen;

  return (
    <Frame>
      {toast && (
        <div style={{ position: "absolute", left: 16, right: 16, bottom: 92, zIndex: 70, background: "rgba(10,10,15,.94)", border: "1px solid var(--line)", borderRadius: 14, padding: "12px 16px", textAlign: "center", fontSize: 13, color: "var(--text)", boxShadow: "0 12px 30px -8px rgba(0,0,0,.7)", animation: "hfRise .22s ease" }}>
          {toast}
        </div>
      )}
      {stakeOpen && me && (
        <StakeSheet
          stakeCents={me.real.stakeCents}
          minCents={me.real.minStakeCents}
          maxCents={me.real.maxStakeCents}
          api={api}
          onClose={() => setStakeOpen(false)}
          onSaved={refreshMe}
          onToast={flashToast}
        />
      )}
      {historyOpen && <HistorySheet me={me} api={api} onClose={closeHistory} onToast={flashToast} />}
      {balanceOpen && <BalanceSheet me={me} api={api} realPusdMicro={realPusdMicro} onClose={closeBalance} onTopupDone={refreshMe} onToast={flashToast} />}
      <Hud me={me} pop={pop} realPusdMicro={realPusdMicro} onShards={goVault} onGM={goGmScreen} onBalance={openBalance} onBell={goNotifs} />

      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        {effectiveScreen === "deck" && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
            <div style={{ position: "relative", flex: 1, margin: "6px 14px 0" }}>
              {capReached ? (
                <div style={{ position: "absolute", inset: 0, borderRadius: 26, background: "var(--panel)", border: "1px solid var(--line)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 28, textAlign: "center", gap: 10 }}>
                  <div style={{ fontFamily: "var(--df)", fontSize: 34 }}>Deck&apos;s done.</div>
                  <p style={{ color: "var(--muted)", fontSize: 14 }}>
                    You spent today&apos;s {me?.swipes.cap} point swipes. Fresh deck at 00:00 UTC — meanwhile, the feed never sleeps.
                  </p>
                  <button
                    type="button"
                    onClick={enterFeedFromCap}
                    style={{ marginTop: 6, padding: "12px 22px", borderRadius: 16, font: "inherit", cursor: "pointer", background: "var(--energy)", color: "#06070a", border: "none", fontWeight: 800, fontSize: 15, letterSpacing: ".02em" }}
                  >
                    Open the Feed →
                  </button>
                  <p style={{ color: "var(--muted)", fontSize: 11, marginTop: 2 }}>No points here — but shards still drop on every win.</p>
                </div>
              ) : (
                <>
                  {/* next card — FULLY rendered behind the top one (not a gray stub) */}
                  {next && <CardPreview key={next.id} card={next} skinId={equippedSkin} stakeCents={effectiveStakeCents} />}
                  {top ? (
                    <DeckCard
                      key={top.id}
                      card={top}
                      skinId={equippedSkin}
                      busy={busy}
                      onAction={handleAction}
                      onTap={noop}
                      stakeCents={effectiveStakeCents}
                      onEditStake={realMode ? () => setStakeOpen(true) : undefined}
                    />
                  ) : (
                    <div style={{ position: "absolute", inset: 0, borderRadius: 26, background: "var(--panel)", border: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center" }}>
                      <p style={{ color: "var(--muted)" }}>No more cards right now. Check back after the next batch resolves.</p>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* fallback buttons — hidden once the daily cap is reached */}
            {!capReached && (
              <>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 18, padding: "14px 0 2px" }}>
                  <CircleBtn glyph="✕" label="No" color="var(--no)" size={56} disabled={busy || !top} onClick={() => top && act(top, "NO")} />
                  <CircleBtn glyph="↑" label="Skip" color="var(--skip)" size={46} disabled={busy || !top} onClick={() => top && act(top, "SKIP")} />
                  <CircleBtn glyph="✓" label="Yes" color="var(--yes)" size={56} disabled={busy || !top} onClick={() => top && act(top, "YES")} />
                </div>
                <div style={{ textAlign: "center", fontSize: 10, color: "var(--muted)", paddingBottom: 8 }}>
                  Skip free — save your swipes for the calls you want
                </div>
              </>
            )}
          </div>
        )}

        {effectiveScreen === "feed" && <FeedScreen api={api} me={me} onRefreshMe={refreshMe} onToast={flashToast} onTopup={openBalance} />}
        {effectiveScreen === "hedge" && <HedgeScreen api={api} me={me} onRefreshMe={refreshMe} onToast={flashToast} onTopup={openBalance} />}
        {effectiveScreen === "gm" && <GmScreen me={me} busy={busy} onGM={gm} onEnterDeck={goDeck} onRevive={revive} />}
        {effectiveScreen === "vault" && <VaultScreen me={me} api={api} onRefresh={refresh} previewCard={top ?? next} />}
        {effectiveScreen === "invite" && <InviteScreen me={me} />}
        {effectiveScreen === "you" && <ProfileScreen me={me} api={api} onRefresh={refresh} onHistory={openHistory} onLogout={doLogout} onToast={flashToast} pusdMicro={realPusdMicro} />}
        {effectiveScreen === "notifications" && <NotificationsScreen api={api} onSeen={markResultsSeen} onReplay={replayReveal} />}
      </div>

      <BottomNav screen={effectiveScreen} onNav={navTo} deckLocked={deckLocked} devFeed={!!me?.dev} />

      {/* Results reveal sits above the whole shell (HUD + nav). */}
      {reveal && (
        <RevealOverlay
          rows={reveal}
          shards={me?.shards ?? 0}
          shardsPerArtifact={me?.shardsPerArtifact ?? 20}
          onDone={finishReveal}
          onSkip={skipReveal}
        />
      )}
    </Frame>
  );
}

// Single boot spinner — the only thing shown before the first real frame. One ring, energy accent.
function Spinner() {
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ width: 38, height: 38, borderRadius: "50%", border: "3px solid var(--line)", borderTopColor: "var(--energy)", animation: "hfSpin .8s linear infinite" }} />
    </div>
  );
}

function CircleBtn({ glyph, label, color, size, disabled, onClick }: { glyph: string; label: string; color: string; size: number; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        // button reset so it renders identical to the original div
        padding: 0, margin: 0, font: "inherit",
        width: size, height: size, borderRadius: "50%", background: "var(--panel)",
        border: `1.5px solid color-mix(in srgb,${color} 55%,var(--line))`, display: "flex",
        alignItems: "center", justifyContent: "center", cursor: disabled ? "default" : "pointer",
        color, fontSize: size > 50 ? 25 : 20, fontWeight: 800, opacity: disabled ? 0.5 : 1,
      }}
    >
      {glyph}
    </button>
  );
}

// Mobile = the real device, so the app is the whole screen (no device mock — that was a
// prototype artifact). Desktop = show the phone mock so a vertical mobile UI doesn't stretch
// across a wide window. The breakpoint is "viewport too narrow to bother framing".
const MOBILE_MAX = 480;

function Frame({ children }: { children: React.ReactNode }) {
  const deviceRef = useRef<HTMLDivElement>(null);
  // Start mobile-first to match the common case; corrected on mount before paint.
  const [isMobile, setIsMobile] = useState(true);

  useEffect(() => {
    const update = () => {
      const mobile = window.innerWidth <= MOBILE_MAX;
      setIsMobile(mobile);
      const d = deviceRef.current;
      if (d && !mobile) {
        const s = Math.min(1, (window.innerHeight - 24) / 872, (window.innerWidth - 24) / 402);
        d.style.transform = `scale(${s})`;
      }
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  if (isMobile) {
    // Fullscreen app surface. Safe-area padding keeps the HUD/nav clear of notch + home bar.
    return (
      <div
        id={APP_SURFACE_ID}
        style={{
          position: "fixed",
          inset: 0,
          background: "var(--bg)",
          display: "flex",
          flexDirection: "column",
          // Clear the notch; min 8px so notch-less phones don't hug the very top edge.
          paddingTop: "max(env(safe-area-inset-top), 8px)",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
      >
        {children}
      </div>
    );
  }

  return (
    <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div ref={deviceRef} style={{ position: "relative", width: 402, height: 872, borderRadius: 48, padding: 11, background: "linear-gradient(160deg,#23232e,#0c0c12)", boxShadow: "0 40px 120px -20px rgba(0,0,0,.8), 0 0 0 1px rgba(255,255,255,.05) inset", transformOrigin: "center" }}>
        <div style={{ position: "absolute", top: 18, left: "50%", transform: "translateX(-50%)", width: 108, height: 30, background: "#000", borderRadius: 18, zIndex: 60 }} />
        {/* paddingTop clears the mock notch — on mobile the safe-area inset on Frame does this. */}
        <div id={APP_SURFACE_ID} style={{ position: "relative", width: "100%", height: "100%", borderRadius: 38, overflow: "hidden", background: "var(--bg)", display: "flex", flexDirection: "column", paddingTop: 30 }}>
          {children}
        </div>
      </div>
    </div>
  );
}
