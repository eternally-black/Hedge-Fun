// Login — Privy auth, native port of src/app/screens/Onboarding.tsx. Each button drives ONE method:
// X → OAuth deep-link round-trip (useLoginWithOAuth), Email → OTP code (useLoginWithEmail).
// The invite-code field is the referral-capture baseline (manual entry — docs/share-and-android.md
// §4): the code is stored on device and POSTed to /api/capture-ref / /api/login-mark after login.
import { useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { useLoginWithEmail, useLoginWithOAuth } from "@privy-io/expo";
import { colors } from "../theme";
import { saveRefCode } from "../refCode";

export function LoginScreen() {
  const oauth = useLoginWithOAuth();
  const email = useLoginWithEmail();
  const [emailAddr, setEmailAddr] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [refCode, setRefCode] = useState("");
  const [refSaved, setRefSaved] = useState(false);

  const oauthBusy = oauth.state.status === "loading";
  const emailStatus = email.state.status;
  const awaitingCode = emailStatus === "awaiting-code-input" || emailStatus === "submitting-code" || emailStatus === "done";

  const loginTwitter = async () => {
    setError(null);
    try {
      // Redirect target = the app.json scheme ("hedgefun://") — whitelist it in the Privy dashboard.
      await oauth.login({ provider: "twitter" });
    } catch {
      setError("X login didn't complete. Try again.");
    }
  };

  const sendEmailCode = async () => {
    setError(null);
    try {
      await email.sendCode({ email: emailAddr.trim() });
    } catch {
      setError("Couldn't send the code. Check the address and try again.");
    }
  };

  const loginEmail = async () => {
    setError(null);
    try {
      await email.loginWithCode({ code: code.trim(), email: emailAddr.trim() });
    } catch {
      setError("Wrong code — try again.");
    }
  };

  const saveRef = async () => {
    if (!refCode.trim()) return;
    await saveRefCode(refCode);
    setRefSaved(true);
  };

  return (
    <KeyboardAvoidingView style={styles.wrap} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <StatusBar style="light" />
      <Text style={styles.kicker}>Hedge Fun</Text>
      <Text style={styles.hero}>CALL IT.{"\n"}FARM IT.</Text>
      <Text style={styles.sub}>Test app — swipe real prediction markets with virtual cash. Zero risk, all dopamine. Stack points.</Text>
      <View style={styles.dirRow}>
        {["⟶ YES", "⟵ NO", "↑ SKIP"].map((t) => (
          <View key={t} style={styles.dirChip}><Text style={styles.dirChipText}>{t}</Text></View>
        ))}
      </View>

      <View style={styles.buttons}>
        <TouchableOpacity style={styles.twitterBtn} onPress={loginTwitter} disabled={oauthBusy}>
          {oauthBusy
            ? <ActivityIndicator color="#111" />
            : <Text style={styles.twitterBtnText}>𝕏 Continue with Twitter</Text>}
        </TouchableOpacity>

        {awaitingCode ? (
          <View style={styles.emailFlow}>
            <TextInput
              style={styles.input}
              value={code}
              onChangeText={setCode}
              placeholder={`Code sent to ${emailAddr.trim()}`}
              placeholderTextColor={colors.muted}
              keyboardType="number-pad"
              autoFocus
            />
            <TouchableOpacity style={styles.emailBtn} onPress={loginEmail} disabled={emailStatus === "submitting-code"}>
              {emailStatus === "submitting-code"
                ? <ActivityIndicator color={colors.text} />
                : <Text style={styles.emailBtnText}>✉ Verify & sign in</Text>}
            </TouchableOpacity>
            <TouchableOpacity onPress={sendEmailCode}>
              <Text style={styles.resend}>Resend code</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.emailFlow}>
            <TextInput
              style={styles.input}
              value={emailAddr}
              onChangeText={setEmailAddr}
              placeholder="you@degen.fun"
              placeholderTextColor={colors.muted}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TouchableOpacity style={styles.emailBtn} onPress={sendEmailCode} disabled={emailStatus === "sending-code" || !emailAddr.trim()}>
              {emailStatus === "sending-code"
                ? <ActivityIndicator color={colors.text} />
                : <Text style={styles.emailBtnText}>✉ Continue with Email</Text>}
            </TouchableOpacity>
          </View>
        )}
        {error && <Text style={styles.error}>{error}</Text>}
      </View>

      {/* Referral capture baseline: manual code entry (docs/share-and-android.md §4 — kept as the
          fallback even after Play Install Referrer lands; the referrer read itself is client-owned
          and TODO — see src/refCode.ts). Stored on device; bound after sign-in. */}
      <View style={styles.refBox}>
        <Text style={styles.refLabel}>Have an invite code?</Text>
        <View style={styles.refRow}>
          <TextInput
            style={[styles.input, styles.refInput]}
            value={refCode}
            onChangeText={(t) => { setRefCode(t); setRefSaved(false); }}
            placeholder="Friend's code"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity style={styles.refBtn} onPress={saveRef} disabled={!refCode.trim() || refSaved}>
            <Text style={styles.refBtnText}>{refSaved ? "Saved ✓" : "Save"}</Text>
          </TouchableOpacity>
        </View>
        {refSaved && <Text style={styles.refSaved}>It&apos;ll be linked when you sign in.</Text>}
      </View>

      <Text style={styles.foot}>No wallet. No seed phrase. No risk.</Text>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center", padding: 32 },
  kicker: { color: colors.energy, fontSize: 13, letterSpacing: 3, textTransform: "uppercase", fontWeight: "700" },
  hero: { color: colors.text, fontSize: 52, lineHeight: 50, fontWeight: "900", textAlign: "center", marginTop: 14 },
  sub: { color: colors.muted, fontSize: 15, textAlign: "center", marginTop: 14, maxWidth: 300, lineHeight: 21 },
  dirRow: { flexDirection: "row", gap: 9, marginTop: 24 },
  dirChip: { backgroundColor: colors.panel, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 20, borderWidth: 1, borderColor: colors.line },
  dirChipText: { color: colors.muted, fontSize: 11 },
  buttons: { width: "100%", maxWidth: 330, marginTop: 30, gap: 10 },
  twitterBtn: { backgroundColor: "#fff", borderRadius: 16, paddingVertical: 15, alignItems: "center" },
  twitterBtnText: { color: "#111", fontWeight: "700", fontSize: 15 },
  emailFlow: { gap: 10 },
  input: {
    backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: 14,
    paddingVertical: 13, paddingHorizontal: 16, color: colors.text, fontSize: 15,
  },
  emailBtn: { backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.line, borderRadius: 16, paddingVertical: 15, alignItems: "center" },
  emailBtnText: { color: colors.text, fontWeight: "700", fontSize: 15 },
  resend: { color: colors.muted, fontSize: 12, textAlign: "center" },
  error: { color: colors.no, fontSize: 12, textAlign: "center" },
  refBox: { width: "100%", maxWidth: 330, marginTop: 26 },
  refLabel: { color: colors.muted, fontSize: 10, letterSpacing: 1.4, textTransform: "uppercase", fontWeight: "700", marginBottom: 8 },
  refRow: { flexDirection: "row", gap: 8 },
  refInput: { flex: 1 },
  refBtn: { backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.line, borderRadius: 14, paddingHorizontal: 18, justifyContent: "center" },
  refBtnText: { color: colors.energy, fontWeight: "700", fontSize: 13 },
  refSaved: { color: colors.muted, fontSize: 11, marginTop: 6 },
  foot: { color: colors.muted, fontSize: 11, marginTop: 22 },
});
