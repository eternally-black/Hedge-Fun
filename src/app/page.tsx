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
import { BalanceSheet } from "./screens/BalanceSheet";
import { NotificationsScreen } from "./screens/NotificationsScreen";
import { RevealOverlay } from "./screens/RevealOverlay";
import { type Card, type Me, type Screen } from "./ui";
import { DECK_MIN_LEAD_MS } from "@/lib/config";
import type { ResultRow, ResultsResponse } from "@/lib/api-types";

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
  const [busy, setBusy] = useState(false);
  const [pop, setPop] = useState<{ amt: number; color: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
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
    setDeck(d.cards as Card[]);
  }, [api]);

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
    api("/api/deck").then((d) => setDeck((d as { cards: Card[] }).cards)).catch(console.error);

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
  }, [authenticated, api]);

  // Preload-ahead: refill well before the deck runs dry (threshold 8, not 1), so a fresh card is
  // always buffered behind the current one. `topping` dedupes so only one fetch is in flight.
  const topUpIfLow = useCallback(
    async (remaining: number) => {
      if (remaining > 8 || topping.current) return;
      topping.current = true;
      try {
        const d: { cards: Card[] } = await api("/api/deck");
        setDeck((cur) => {
          const have = new Set(cur.map((c) => c.id));
          return [...cur, ...d.cards.filter((c) => !have.has(c.id))];
        });
      } catch (e) {
        console.error(e);
      } finally {
        topping.current = false;
      }
    },
    [api],
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
      if (action !== "SKIP" && m && m.cashCents < m.stakeCents) {
        flashToast("No free cash left");
        return;
      }
      // OPTIMISTIC: advance the deck immediately so the next card rises in sync with the fly-out
      // animation (the gesture already committed). The network call runs in the background — we
      // do NOT block the UI on it, which is what made advancing feel laggy/network-coupled.
      advance();
      flashPop(action === "SKIP" ? 0 : 1, action === "SKIP" ? "var(--skip)" : action === "YES" ? "var(--yes)" : "var(--no)");

      const req = action === "SKIP"
        ? api("/api/skip", { method: "POST" })
        : api("/api/swipe", { method: "POST", body: JSON.stringify({ marketId: card.id, side: action }) });
      req
        .then(() => refreshMe()) // stats only (points/shards/balance/skip counter); never the deck
        .catch((e) => {
          const status = (e as { status?: number }).status;
          // 403 = daily swipe cap hit (raced past the client gate). The bet wasn't stored;
          // refreshMe pulls used>=cap, which flips capReached and shows the limit screen.
          if (status === 403) { flashToast("Daily limit reached — back at 00:00 UTC"); void refreshMe(); }
          // 402 = no free cash for a swipe (we pre-gate, so this means a race). The swipe tx rolled
          // back (no bet row), so the market re-enters a future deck — the card isn't lost. Skips
          // never 402 anymore (always free).
          else if (status === 402) { flashToast("No free cash left"); void refreshMe(); }
          else if (status !== 409) console.error(e);
        });
    },
    [api, refreshMe, topUpIfLow, flashPop, flashToast],
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

  // Stable nav callbacks so memo'd Hud/BottomNav don't re-render on unrelated state changes.
  const goVault = useCallback(() => setScreen("vault"), []);
  const goGmScreen = useCallback(() => setScreen("gm"), []);
  const openHistory = useCallback(() => setHistoryOpen(true), []);
  const closeHistory = useCallback(() => setHistoryOpen(false), []);
  const openBalance = useCallback(() => setBalanceOpen(true), []);
  const closeBalance = useCallback(() => setBalanceOpen(false), []);
  const goDeck = useCallback(() => setScreen("deck"), []);
  const goFeed = useCallback(() => setScreen("feed"), []);
  const goNotifs = useCallback(() => setScreen("notifications"), []);

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
  // Hard daily cap: once a non-dev user hits the swipe cap, stop the deck and show the
  // "come back tomorrow" screen. Dev accounts swipe unlimited (and have a deck reset).
  const capReached = !!me && !me.dev && me.swipes.used >= me.swipes.cap;
  // The feed unlocks once the swipe cap is spent (dev accounts always — they never hit capReached).
  // Derived during render (no effect/stored state) — drives both the cap-screen CTA and the nav tab.
  const feedUnlocked = !!me && (me.dev || me.swipes.used >= me.swipes.cap);

  return (
    <Frame>
      {toast && (
        <div style={{ position: "absolute", left: 16, right: 16, bottom: 92, zIndex: 70, background: "rgba(10,10,15,.94)", border: "1px solid var(--line)", borderRadius: 14, padding: "12px 16px", textAlign: "center", fontSize: 13, color: "var(--text)", boxShadow: "0 12px 30px -8px rgba(0,0,0,.7)", animation: "hfRise .22s ease" }}>
          {toast}
        </div>
      )}
      {historyOpen && <HistorySheet api={api} onClose={closeHistory} />}
      {balanceOpen && <BalanceSheet me={me} api={api} onClose={closeBalance} onTopupDone={refreshMe} onToast={flashToast} />}
      <Hud me={me} pop={pop} onShards={goVault} onGM={goGmScreen} onBalance={openBalance} onBell={goNotifs} />

      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        {screen === "deck" && (
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
                    onClick={goFeed}
                    style={{ marginTop: 6, padding: "12px 22px", borderRadius: 16, font: "inherit", cursor: "pointer", background: "var(--energy)", color: "#06070a", border: "none", fontWeight: 800, fontSize: 15, letterSpacing: ".02em" }}
                  >
                    Open the Feed →
                  </button>
                  <p style={{ color: "var(--muted)", fontSize: 11, marginTop: 2 }}>No points here — but shards still drop on every win.</p>
                </div>
              ) : (
                <>
                  {/* next card — FULLY rendered behind the top one (not a gray stub) */}
                  {next && <CardPreview key={next.id} card={next} />}
                  {top ? (
                    <DeckCard key={top.id} card={top} busy={busy} onAction={handleAction} onTap={noop} />
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

        {screen === "feed" && <FeedScreen api={api} me={me} onRefreshMe={refreshMe} onToast={flashToast} onTopup={openBalance} />}
        {screen === "gm" && <GmScreen me={me} busy={busy} onGM={gm} onEnterDeck={goDeck} />}
        {screen === "vault" && <VaultScreen me={me} api={api} onRefresh={refresh} />}
        {screen === "invite" && <InviteScreen me={me} />}
        {screen === "you" && <ProfileScreen me={me} api={api} onRefresh={refresh} onHistory={openHistory} onLogout={doLogout} />}
        {screen === "notifications" && <NotificationsScreen api={api} onSeen={markResultsSeen} onReplay={replayReveal} />}
      </div>

      <BottomNav screen={screen} onNav={setScreen} feedUnlocked={feedUnlocked} />

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
        <div style={{ position: "relative", width: "100%", height: "100%", borderRadius: 38, overflow: "hidden", background: "var(--bg)", display: "flex", flexDirection: "column", paddingTop: 30 }}>
          {children}
        </div>
      </div>
    </div>
  );
}
