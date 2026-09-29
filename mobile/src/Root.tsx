// Root — the native twin of src/app/page.tsx: auth gate, boot ritual, screen state machine,
// persistent HUD + bottom nav, toast, and the wallet sheet. Server data is rendered as-is.
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Platform, StatusBar as RNStatusBar, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { usePrivy } from "@privy-io/expo";
import { useApi, statusOf } from "./api";
import { colors } from "./theme";
import { clearRefCode, readInstallReferrerCode, readRefCode, saveRefCode } from "./refCode";
import type { CaptureRefResponse, MeResponse, ResultRow, ResultsResponse } from "@contract/api-types";
import { Hud } from "./components/Hud";
import { BottomNav, type Screen } from "./components/BottomNav";
import { WalletSheet } from "./components/WalletSheet";
import { useStockPocket } from "./useStockPocket";
import { LoginScreen } from "./screens/LoginScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { DeckScreen } from "./screens/DeckScreen";
import { HedgeScreen } from "./screens/HedgeScreen";
import { ResultsScreen } from "./screens/ResultsScreen";
import { RevealOverlay } from "./components/RevealOverlay";
import { ProfileScreen } from "./screens/ProfileScreen";
import { DeckModePill, StockDeckScreen, type DeckMode } from "./screens/StockDeckScreen";
import { PortfolioScreen } from "./screens/PortfolioScreen";
import { loadTradingWalletChoice } from "./tradingWallet";
import * as wallet from "./platform/wallet.flavor";

export default function Root() {
  const { isReady, user, logout } = usePrivy();
  const api = useApi();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [screen, setScreen] = useState<Screen>("deck");
  // Which deck occupies the Deck tab — the same pill the web shows above the card slot.
  const [deckMode, setDeckMode] = useState<DeckMode>("predictions");
  // The remembered trading-wallet pick (Profile → Wallet → Use) is read once, before any real trade.
  useEffect(() => { void loadTradingWalletChoice(); }, []);
  // First-paint gate: spinner until me + results are loaded and the landing screen is decided —
  // the first content frame is already the right screen (mirrors the web boot).
  const [booted, setBooted] = useState(false);
  const ritualDone = useRef(false); // run the auth→boot sequence once per login
  const [toast, setToast] = useState<string | null>(null);
  const [walletOpen, setWalletOpen] = useState(false);
  // The results reveal overlay (the web's `reveal`). "ritual" = the boot reveal (finishing may route
  // to Home for the GM check-in); "replay" = asked for from Results, so finishing lands on the deck.
  const [reveal, setReveal] = useState<ResultRow[] | null>(null);
  const revealMode = useRef<"ritual" | "replay">("ritual");
  // What the overlay is delivering, so finishing acknowledges exactly those rows in that mode.
  const revealDelivery = useRef<{ mode: "PAPER" | "REAL"; betIds: string[]; unreadCount: number } | null>(null);
  const [realPusdMicro, setRealPusdMicro] = useState<string | null>(null);
  // Bumped on logout: a /api/real/wallet response that outlived its session must not paint the next
  // account's HUD with the previous account's balance.
  const balanceGen = useRef(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const meRef = useRef<MeResponse | null>(null);
  useEffect(() => { meRef.current = me; }, [me]);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const flashToast = useCallback((msg: string) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }, []);

  // Sign out: clear local account state so a re-login boots fresh, then end the Privy session.
  const doLogout = useCallback(async () => {
    setMe(null);
    setScreen("deck");
    setBooted(false);
    ritualDone.current = false;
    balanceGen.current++;
    setRealPusdMicro(null);
    setReveal(null);
    await logout().catch(console.error);
  }, [logout]);

  // Stats only — after any economy action. The deck refetches itself; this never touches it.
  // F11: owns its OWN error handling so every fire-and-forget caller (`void onRefreshMe()`) can't leak
  // an unhandled rejection. A dead Privy session surfaces as a 401 → sign the user out to the login
  // screen instead of looping on a call that will never succeed; any other blip leaves the last-known
  // HUD in place and flashes a quiet notice (the next successful action re-syncs it).
  const refreshMe = useCallback(async () => {
    try {
      setMe((await api("/api/me")) as MeResponse);
    } catch (e) {
      if (statusOf(e) === 401) { await doLogout(); return; }
      console.error(e);
      flashToast("Couldn't refresh — showing last balance");
    }
  }, [api, doLogout, flashToast]);

  // Real mode = the build can sign (Seeker flavor) AND the account is in REAL. The Play build has
  // no wallet port, so it stays paper-only no matter what the account says.
  const realMode = wallet.available && me?.real.mode === "REAL";
  // An RPC hiccup shows "—", never a misleading $0.00.
  const refreshRealBalance = useCallback(async () => {
    // Every read takes a new generation, so only the LATEST one may paint: an older read that lands
    // after a post-order refresh must not put the pre-order balance back.
    const gen = ++balanceGen.current;
    try {
      const r = (await api("/api/real/wallet")) as { pusdMicro?: string | null };
      if (gen === balanceGen.current) setRealPusdMicro(r.pusdMicro ?? null);
    } catch {
      if (gen === balanceGen.current) setRealPusdMicro(null);
    }
  }, [api]);
  // The HUD states this number on every screen, so it must become true on its own after a deposit.
  useEffect(() => {
    if (!realMode) { setRealPusdMicro(null); return; }
    void refreshRealBalance();
    const id = setInterval(() => {
      if (AppState.currentState === "active") void refreshRealBalance();
    }, 30_000);
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") void refreshRealBalance(); });
    return () => { clearInterval(id); sub.remove(); balanceGen.current++; };
  }, [realMode, refreshRealBalance]);

  // The chip states the pocket the screen spends — web page.tsx derives it the same way.
  const hudPocket: "stocks" | "predictions" = screen === "stocks" || (screen === "deck" && deckMode === "stocks") ? "stocks" : "predictions";
  // Read only when something shows it: the HUD chip or the wallet sheet.
  const stock = useStockPocket(me, api, walletOpen || (realMode && hudPocket === "stocks"));

  // Boot: one coherent first-load sequence per auth (mirrors the web ritual):
  //   1. referral capture on open — /api/capture-ref, NEVER marks the GM day (idempotent);
  //   2. me + results decide the landing screen:
  //      • brand-new user → straight to the deck, zero popups;
  //      • unseen results → the reveal overlay (the web's ritual), then Home/deck on finish;
  //      • else not GM'd today → Home (the once-a-day check-in is the open ritual);
  //      • else → deck.
  useEffect(() => {
    if (!isReady || !user || ritualDone.current) return;
    ritualDone.current = true;
    void (async () => {
      try {
        // Install referrer first (TODO client-owned — returns null until the store listing exists),
        // then whatever code is stored on device (manual entry on the login screen).
        const installCode = await readInstallReferrerCode();
        if (installCode) await saveRefCode(installCode);
        const code = installCode ?? (await readRefCode());
        api(code ? `/api/capture-ref?ref=${encodeURIComponent(code)}` : "/api/capture-ref", { method: "POST" })
          .then((r) => { if ((r as CaptureRefResponse).captured) void clearRefCode(); })
          .catch(() => { /* idempotent; the GM tap also captures */ });

        const [m, r] = await Promise.all([api("/api/me"), api("/api/results?unseen=1")]);
        const meData = m as MeResponse;
        setMe(meData);
        const res = r as ResultsResponse;
        const unseen = res.rows.filter((row) => !row.seen);
        if (meData.isNewUser) setScreen("deck");
        else if (unseen.length > 0) {
          // The reveal ritual: play the unseen rows, then acknowledge exactly them on finish.
          revealMode.current = "ritual";
          revealDelivery.current = { mode: res.mode, betIds: unseen.map((row) => row.id), unreadCount: unseen.length };
          setReveal(unseen);
        } else if (!meData.loginMarkedToday) setScreen("home");
        else setScreen("deck");
      } catch (e) {
        console.error(e); // boot failure still lands on the deck, which shows its own retry
      } finally {
        setBooted(true);
      }
    })();
  }, [isReady, user, api]);

  // Decrement only what was actually delivered — bets AND stock alerts (the bell counts both).
  const markResultsSeen = useCallback((betCount: number, stockCount: number) => {
    setMe((m) => (m ? {
      ...m,
      unreadResults: Math.max(0, m.unreadResults - betCount),
      unreadStockAlerts: Math.max(0, (m.unreadStockAlerts ?? 0) - stockCount),
    } : m));
  }, []);

  // Where a closed reveal leads: a ritual that hasn't checked in today still owes the GM tap (Home);
  // everything else, and every replay, lands on the deck.
  const exitReveal = useCallback(() => {
    const m = meRef.current;
    if (revealMode.current === "ritual" && m && !m.loginMarkedToday) setScreen("home");
    else setScreen("deck");
  }, []);

  // Watching through to the summary clears unread (server-side ack of exactly the delivered rows);
  // skip is the safety net and acknowledges nothing — unwatched results stay badged.
  const finishReveal = useCallback(() => {
    const delivered = revealDelivery.current;
    revealDelivery.current = null;
    setReveal(null);
    if (delivered && delivered.betIds.length > 0) {
      markResultsSeen(delivered.unreadCount, 0);
      api("/api/results/seen", { method: "POST", body: JSON.stringify({ scope: "bets", mode: delivered.mode, betIds: delivered.betIds }) })
        .catch(console.error)
        .finally(() => { void refreshMe(); });
    } else {
      void refreshMe();
    }
    exitReveal();
  }, [api, markResultsSeen, refreshMe, exitReveal]);
  const skipReveal = useCallback(() => {
    revealDelivery.current = null;
    setReveal(null);
    exitReveal();
    void refreshMe();
  }, [exitReveal, refreshMe]);
  // Replay from Results re-opens the whole feed as a re-watch.
  const replayReveal = useCallback(() => {
    api("/api/results")
      .then((r) => {
        const results = r as ResultsResponse;
        revealMode.current = "replay";
        revealDelivery.current = { mode: results.mode, betIds: results.rows.map((row) => row.id), unreadCount: results.rows.filter((row) => !row.seen).length };
        setReveal(results.rows);
      })
      .catch(console.error);
  }, [api]);

  const openWallet = useCallback(() => setWalletOpen(true), []);
  const closeWallet = useCallback(() => setWalletOpen(false), []);
  const goHome = useCallback(() => setScreen("home"), []);
  const goResults = useCallback(() => setScreen("results"), []);
  const goDeck = useCallback(() => setScreen("deck"), []);
  const goProfile = useCallback(() => setScreen("profile"), []);
  const goStocksDeck = useCallback(() => setDeckMode("stocks"), []);
  const goStocks = useCallback(() => setScreen("stocks"), []);

  if (!isReady) return <Boot />;
  if (!user) return <LoginScreen />;
  if (!booted) return <Boot />;

  return (
    <View style={styles.shell}>
      <StatusBar style="light" />
      <Hud
        me={me}
        onGM={goHome}
        onBalance={openWallet}
        onBell={goResults}
        pocket={hudPocket}
        stocksUsdCents={stock.usdCents}
        realPusdMicro={realPusdMicro}
      />
      <View style={styles.body}>
        {screen === "home" && <HomeScreen me={me} api={api} onRefreshMe={refreshMe} onEnterDeck={goDeck} />}
        {/* The Deck tab holds two decks behind one pill. Stocks trade in whichever economy the account
            is in (real money = the connected wallet, via the Seeker flavor's wallet port). Predictions
            trade real money on the Seeker build through the shared web client (Privy embedded EVM
            wallet — the same signer the web uses). The Play build has no wallet port, so a real-mode
            account there gets the notice, never the paper deck (the server follows the account's mode
            for history/results, so paper swipes would write PAPER bets while /api/history reads REAL). */}
        {screen === "deck" && (
          <View style={styles.body}>
            <DeckModePill mode={deckMode} onMode={setDeckMode} />
            {deckMode === "stocks" ? (
              <StockDeckScreen me={me} api={api} onRefreshMe={refreshMe} onToast={flashToast} onNeedWallet={goProfile} />
            ) : me?.real?.mode === "REAL" && !wallet.available ? (
              <View style={styles.realNotice}>
                <Text style={styles.realNoticeTitle}>Real-money mode is on</Text>
                <Text style={styles.realNoticeBody}>
                  Real money isn&apos;t available in this app. Switch back to play money in Profile to keep swiping.
                </Text>
                <TouchableOpacity style={styles.realNoticeBtn} onPress={goStocksDeck} accessibilityRole="button">
                  <Text style={styles.realNoticeBtnText}>Open the Stocks deck</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <DeckScreen
                me={me}
                api={api}
                onRefreshMe={refreshMe}
                onToast={flashToast}
                onTopup={openWallet}
                realMode={realMode}
                onRealOrderDone={refreshRealBalance}
              />
            )}
          </View>
        )}
        {screen === "stocks" && <PortfolioScreen me={me} api={api} onRefreshMe={refreshMe} onToast={flashToast} onNeedWallet={goProfile} />}
        {screen === "hedge" && <HedgeScreen me={me} api={api} onRefreshMe={refreshMe} onToast={flashToast} onTopup={openWallet} />}
        {screen === "results" && <ResultsScreen api={api} onSeen={markResultsSeen} onAckFailed={refreshMe} onReplay={replayReveal} onOpenStock={goStocks} />}
        {screen === "profile" && <ProfileScreen me={me} api={api} onRefreshMe={refreshMe} onLogout={doLogout} onToast={flashToast} />}
      </View>
      <BottomNav screen={screen} onNav={setScreen} />
      {toast && (
        <View style={styles.toast}>
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      )}
      <WalletSheet visible={walletOpen} me={me} api={api} realPusdMicro={realPusdMicro} stock={stock} onClose={closeWallet} onTopupDone={refreshMe} onToast={flashToast} />
      {/* The reveal covers the HUD and the nav — the last child of the shell, like the web. */}
      {reveal ? (
        <RevealOverlay
          rows={reveal}
          shards={me?.shards ?? 0}
          shardsPerArtifact={me?.shardsPerArtifact ?? 20}
          onDone={finishReveal}
          onSkip={skipReveal}
        />
      ) : null}
    </View>
  );
}

function Boot() {
  return (
    <View style={styles.boot}>
      <StatusBar style="light" />
      <ActivityIndicator size="large" color={colors.energy} />
    </View>
  );
}

const topPad = Platform.OS === "android" ? (RNStatusBar.currentHeight ?? 0) : 0;

const styles = StyleSheet.create({
  shell: { flex: 1, backgroundColor: colors.bg, paddingTop: topPad },
  body: { flex: 1 },
  boot: { flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center" },
  toast: {
    position: "absolute", left: 16, right: 16, bottom: 92,
    backgroundColor: "rgba(10,10,15,0.94)", borderWidth: 1, borderColor: colors.line,
    borderRadius: 14, paddingVertical: 12, paddingHorizontal: 16, alignItems: "center",
  },
  toastText: { color: colors.text, fontSize: 13 },
  realNotice: {
    flex: 1, alignItems: "center", justifyContent: "center", padding: 24,
    backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line,
    borderRadius: 18, margin: 16,
  },
  realNoticeTitle: { color: colors.text, fontSize: 20, fontWeight: "900", textAlign: "center" },
  realNoticeBody: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 8, textAlign: "center", maxWidth: 280 },
  realNoticeBtn: {
    marginTop: 18, paddingVertical: 12, paddingHorizontal: 24, borderRadius: 14,
    backgroundColor: colors.energy, alignItems: "center",
  },
  realNoticeBtnText: { color: "#fff", fontSize: 14, fontWeight: "800" },
});
