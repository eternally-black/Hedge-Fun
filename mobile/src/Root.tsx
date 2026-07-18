// Root — the native twin of src/app/page.tsx: auth gate, boot ritual, screen state machine,
// persistent HUD + bottom nav, toast, and the top-up sheet. Server data is rendered as-is.
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, StatusBar as RNStatusBar, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { usePrivy } from "@privy-io/expo";
import { useApi } from "./api";
import { colors } from "./theme";
import { clearRefCode, readInstallReferrerCode, readRefCode, saveRefCode } from "./refCode";
import type { CaptureRefResponse, MeResponse, ResultsResponse } from "../lib/api-types";
import { Hud } from "./components/Hud";
import { BottomNav, type Screen } from "./components/BottomNav";
import { TopupSheet } from "./components/TopupSheet";
import { LoginScreen } from "./screens/LoginScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { DeckScreen } from "./screens/DeckScreen";
import { HedgeScreen } from "./screens/HedgeScreen";
import { ResultsScreen } from "./screens/ResultsScreen";
import { ProfileScreen } from "./screens/ProfileScreen";

export default function Root() {
  const { isReady, user, logout } = usePrivy();
  const api = useApi();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [screen, setScreen] = useState<Screen>("deck");
  // First-paint gate: spinner until me + results are loaded and the landing screen is decided —
  // the first content frame is already the right screen (mirrors the web boot).
  const [booted, setBooted] = useState(false);
  const ritualDone = useRef(false); // run the auth→boot sequence once per login
  const [toast, setToast] = useState<string | null>(null);
  const [topupOpen, setTopupOpen] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const meRef = useRef<MeResponse | null>(null);
  useEffect(() => { meRef.current = me; }, [me]);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  // Stats only — after any economy action. The deck refetches itself; this never touches it.
  const refreshMe = useCallback(async () => {
    setMe((await api("/api/me")) as MeResponse);
  }, [api]);

  const flashToast = useCallback((msg: string) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }, []);

  // Boot: one coherent first-load sequence per auth (mirrors the web ritual):
  //   1. referral capture on open — /api/capture-ref, NEVER marks the GM day (idempotent);
  //   2. me + results decide the landing screen:
  //      • brand-new user → straight to the deck, zero popups;
  //      • unseen results → the inbox (the slice's stand-in for the web's reveal overlay);
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

        const [m, r] = await Promise.all([api("/api/me"), api("/api/results")]);
        const meData = m as MeResponse;
        setMe(meData);
        const unseen = (r as ResultsResponse).rows.filter((row) => !row.seen);
        if (meData.isNewUser) setScreen("deck");
        else if (unseen.length > 0) setScreen("results");
        else if (!meData.loginMarkedToday) setScreen("home");
        else setScreen("deck");
      } catch (e) {
        console.error(e); // boot failure still lands on the deck, which shows its own retry
      } finally {
        setBooted(true);
      }
    })();
  }, [isReady, user, api]);

  // Sign out: clear local account state so a re-login boots fresh, then end the Privy session.
  const doLogout = useCallback(async () => {
    setMe(null);
    setScreen("deck");
    setBooted(false);
    ritualDone.current = false;
    await logout().catch(console.error);
  }, [logout]);

  // Opening the inbox clears the badge optimistically; ResultsScreen POSTs /api/results/seen and
  // the next /api/me confirms unreadResults=0.
  const markResultsSeen = useCallback(() => {
    setMe((m) => (m && m.unreadResults ? { ...m, unreadResults: 0 } : m));
  }, []);

  const openTopup = useCallback(() => setTopupOpen(true), []);
  const closeTopup = useCallback(() => setTopupOpen(false), []);
  const goHome = useCallback(() => setScreen("home"), []);
  const goResults = useCallback(() => setScreen("results"), []);
  const goDeck = useCallback(() => setScreen("deck"), []);

  if (!isReady) return <Boot />;
  if (!user) return <LoginScreen />;
  if (!booted) return <Boot />;

  return (
    <View style={styles.shell}>
      <StatusBar style="light" />
      <Hud me={me} onGM={goHome} onBalance={openTopup} onBell={goResults} />
      <View style={styles.body}>
        {screen === "home" && <HomeScreen me={me} api={api} onRefreshMe={refreshMe} onEnterDeck={goDeck} />}
        {screen === "deck" && <DeckScreen me={me} api={api} onRefreshMe={refreshMe} onToast={flashToast} onTopup={openTopup} />}
        {screen === "hedge" && <HedgeScreen me={me} api={api} onRefreshMe={refreshMe} onToast={flashToast} onTopup={openTopup} />}
        {screen === "results" && <ResultsScreen api={api} onSeen={markResultsSeen} />}
        {screen === "profile" && <ProfileScreen me={me} api={api} onLogout={doLogout} onToast={flashToast} />}
      </View>
      <BottomNav screen={screen} onNav={setScreen} />
      {toast && (
        <View style={styles.toast}>
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      )}
      <TopupSheet visible={topupOpen} me={me} api={api} onClose={closeTopup} onTopupDone={refreshMe} onToast={flashToast} />
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
});
