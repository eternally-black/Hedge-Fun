"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import { LeaderboardScreen } from "./screens/LeaderboardScreen";
import { HistorySheet } from "./screens/HistorySheet";
import { type Card, type Me, type Screen } from "./ui";

const PRIVY_ON = !!process.env.NEXT_PUBLIC_PRIVY_APP_ID;

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
  const { ready, authenticated, login } = usePrivy();
  const api = useApi();
  const [me, setMe] = useState<Me | null>(null);
  const [deck, setDeck] = useState<Card[]>([]);
  const [screen, setScreen] = useState<Screen>("deck");
  const [busy, setBusy] = useState(false);
  const [pop, setPop] = useState<{ amt: number; color: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
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

  useEffect(() => {
    if (!authenticated) return;
    refresh().catch(console.error);
    // Forward the stealth referral code (cookie → localStorage fallback) on first auth, so a user
    // who swipes before ever tapping GM still attributes. The URL stays clean (no ?ref=); the code
    // travels in the cookie the middleware set. Server captures once (unique inviteeId) AND, if no
    // code is present, runs the IP/UA device fallback — so we send login-mark either way.
    const ref = readRef();
    const path = ref ? `/api/login-mark?ref=${encodeURIComponent(ref)}` : "/api/login-mark";
    api(path, { method: "POST" }).catch(() => { /* GM tap retries; capture is idempotent */ });
  }, [authenticated, refresh, api]);

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

  // Act on the top card: YES/NO post a bet, SKIP posts to /api/skip (first free then 1 shard,
  // blocked at 402). The card advances; a swipe-409 (already bet) advances too. Backend contracts
  // (cents, named-binary, points/shards/skip economy) unchanged.
  const act = useCallback(
    (card: Card, action: SwipeAction) => {
      const advance = () =>
        setDeck((d) => {
          const next = d.filter((c) => c.id !== card.id);
          void topUpIfLow(next.length);
          return next;
        });
      // Gate a blocked skip client-side so we don't fire a request we know will 402.
      if (action === "SKIP" && me && !me.skips.nextIsFree && me.shards < me.skips.shardCost) {
        flashToast("No shards — earn one (or wait for tomorrow's free skip)");
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
          // 409 (already bet) is fine — the card's gone anyway. 402 (skip blocked) shouldn't
          // happen since we gate above, but if it races, just surface it. Card already advanced.
          else if (status === 402) flashToast("No shards — earn one (or wait for tomorrow's free skip)");
          else if (status !== 409) console.error(e);
        });
    },
    [api, me, refreshMe, topUpIfLow, flashPop, flashToast],
  );

  // Stable handlers for the keyed DeckCard so it isn't handed new function props each render.
  // handleAction reads the current top via a ref (kept in sync below).
  const topRef = useRef<Card | undefined>(undefined);
  const handleAction = useCallback((a: SwipeAction) => { if (topRef.current) act(topRef.current, a); }, [act]);
  const noop = useCallback(() => {}, []); // tap-for-detail: sheet TODO

  const gm = useCallback(async () => {
    setBusy(true);
    try {
      const ref = readRef();
      await api(ref ? `/api/login-mark?ref=${encodeURIComponent(ref)}` : "/api/login-mark", { method: "POST" });
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [api, refresh]);

  // Stable nav callbacks so memo'd Hud/BottomNav don't re-render on unrelated state changes.
  const goVault = useCallback(() => setScreen("vault"), []);
  const goGmScreen = useCallback(() => setScreen("gm"), []);
  const goLeaderboard = useCallback(() => setScreen("leaderboard"), []);
  const openHistory = useCallback(() => setHistoryOpen(true), []);
  const closeHistory = useCallback(() => setHistoryOpen(false), []);

  if (!ready) return <Frame><div style={{ marginTop: 200, textAlign: "center", color: "var(--muted)" }}>Loading…</div></Frame>;
  if (!authenticated) return <Frame><Onboarding onLogin={login} /></Frame>;

  const top = deck[0];
  const next = deck[1];
  topRef.current = top; // keep the stable handleAction pointed at the live top card
  // Skip is blocked when the free daily skip is used AND the user can't afford the shard cost.
  const skipBlocked = !!me && !me.skips.nextIsFree && me.shards < me.skips.shardCost;
  // Hard daily cap: once a non-dev user hits the swipe cap, stop the deck and show the
  // "come back tomorrow" screen. Dev accounts swipe unlimited (and have a deck reset).
  const capReached = !!me && !me.dev && me.swipes.used >= me.swipes.cap;

  return (
    <Frame>
      {toast && (
        <div style={{ position: "absolute", left: 16, right: 16, bottom: 92, zIndex: 70, background: "rgba(10,10,15,.94)", border: "1px solid var(--line)", borderRadius: 14, padding: "12px 16px", textAlign: "center", fontSize: 13, color: "var(--text)", boxShadow: "0 12px 30px -8px rgba(0,0,0,.7)", animation: "hfRise .22s ease" }}>
          {toast}
        </div>
      )}
      {historyOpen && <HistorySheet api={api} onClose={closeHistory} />}
      <Hud me={me} pop={pop} onShards={goVault} onGM={goGmScreen} onBalance={openHistory} />

      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        {screen === "deck" && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
            <div style={{ position: "relative", flex: 1, margin: "6px 14px 0" }}>
              {capReached ? (
                <div style={{ position: "absolute", inset: 0, borderRadius: 26, background: "var(--panel)", border: "1px solid var(--line)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 28, textAlign: "center", gap: 10 }}>
                  <div style={{ fontFamily: "var(--df)", fontSize: 34 }}>That&apos;s a wrap.</div>
                  <p style={{ color: "var(--muted)", fontSize: 14 }}>
                    You hit today&apos;s {me?.swipes.cap} swipes. Come back after 00:00 UTC for a fresh deck.
                  </p>
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
                  <CircleBtn glyph="✕" color="var(--no)" size={56} disabled={busy || !top} onClick={() => top && act(top, "NO")} />
                  <CircleBtn glyph="↑" color="var(--skip)" size={46} disabled={busy || !top || skipBlocked} onClick={() => top && act(top, "SKIP")} />
                  <CircleBtn glyph="✓" color="var(--yes)" size={56} disabled={busy || !top} onClick={() => top && act(top, "YES")} />
                </div>
                <div style={{ textAlign: "center", fontSize: 10, color: "var(--muted)", paddingBottom: 8 }}>
                  {me?.skips.nextIsFree
                    ? "Skip free today"
                    : skipBlocked
                      ? "Skip needs 1 ◆ — none left"
                      : `Skip costs 1 ◆`}
                </div>
              </>
            )}
          </div>
        )}

        {screen === "gm" && <GmScreen me={me} busy={busy} onGM={gm} />}
        {screen === "vault" && <VaultScreen me={me} api={api} onRefresh={refresh} />}
        {screen === "invite" && <InviteScreen me={me} />}
        {screen === "you" && <ProfileScreen me={me} api={api} onLeaderboard={goLeaderboard} onRefresh={refresh} onHistory={openHistory} />}
        {screen === "leaderboard" && <LeaderboardScreen api={api} />}
      </div>

      <BottomNav screen={screen} onNav={setScreen} />
    </Frame>
  );
}

function CircleBtn({ glyph, color, size, disabled, onClick }: { glyph: string; color: string; size: number; disabled?: boolean; onClick: () => void }) {
  return (
    <div
      onClick={disabled ? undefined : onClick}
      style={{
        width: size, height: size, borderRadius: "50%", background: "var(--panel)",
        border: `1.5px solid color-mix(in srgb,${color} 55%,var(--line))`, display: "flex",
        alignItems: "center", justifyContent: "center", cursor: disabled ? "default" : "pointer",
        color, fontSize: size > 50 ? 25 : 20, fontWeight: 800, opacity: disabled ? 0.5 : 1,
      }}
    >
      {glyph}
    </div>
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
