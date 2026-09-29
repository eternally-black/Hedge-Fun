// Invite — native port of src/app/screens/InviteScreen.tsx (hero, invite link, X/TG share, referral
// stats) plus the manual ref-code entry that used to live on Profile — the referral-capture baseline,
// same as on the login screen. Share goes through openShareNative (docs/share-and-android.md §3).
import { useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import type { CaptureRefResponse, MeResponse } from "@contract/api-types";
import { type Api } from "../api";
import { colors } from "../theme";
import { num } from "../format";
import { clearRefCode, saveRefCode } from "../refCode";
import { composeTgShare, composeXShare, INVITE_TG, INVITE_X, refLink } from "@contract/share";
import { SHARE_BASE_URL } from "../../lib/config";
import { openShareNative } from "../openShareNative";

export function InviteScreen({ me, api, onToast }: { me: MeResponse | null; api: Api; onToast: (msg: string) => void }) {
  // The user's REAL referralCode (P-11: 20% of a friend's points forever, once they make their first
  // 10 calls). refLink → the stealth /r/<code> path; the display drops the scheme.
  const code = me?.user.referralCode ?? null;
  const fullLink = code ? refLink(code, SHARE_BASE_URL) : null;
  const link = fullLink ? fullLink.replace(/^https?:\/\//, "") : "…";
  const [copied, setCopied] = useState(false);

  // Manual ref-code entry (a friend invited THIS user): stored on device, then bound right away via
  // /api/capture-ref (idempotent). If the bind fails, the stored code rides the next GM tap.
  const [refInput, setRefInput] = useState("");
  const [refBusy, setRefBusy] = useState(false);

  const copy = async () => {
    if (!fullLink) return;
    await Clipboard.setStringAsync(fullLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const saveRef = async () => {
    const c = refInput.trim();
    if (!c || refBusy) return;
    setRefBusy(true);
    try {
      await saveRefCode(c);
      const r = (await api(`/api/capture-ref?ref=${encodeURIComponent(c)}`, { method: "POST" })) as CaptureRefResponse;
      if (r.captured) {
        await clearRefCode();
        setRefInput("");
        onToast("Invite code linked ✓");
      } else {
        onToast("That code didn't take — you may already be linked");
      }
    } catch {
      onToast("Couldn't reach the server — code saved for the next check-in");
    } finally {
      setRefBusy(false);
    }
  };

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <Text style={styles.hero}>🤝</Text>
      <Text style={styles.title}>Farm faster{"\n"}with friends</Text>
      <Text style={styles.sub}>You earn 20% of every friend&apos;s points — forever — once they make their first 10 calls.</Text>

      <View style={styles.linkRow}>
        <Text style={styles.linkText} numberOfLines={1}>{link}</Text>
        <TouchableOpacity style={styles.copyBtn} onPress={() => void copy()} disabled={!fullLink} accessibilityLabel="Copy invite link">
          <Text style={styles.copyBtnText}>{copied ? "Copied!" : "Copy"}</Text>
        </TouchableOpacity>
      </View>

      {/* Each tap rolls a random copy line and opens the composer; copy-link lives on the row above. */}
      <View style={styles.shareRow}>
        <TouchableOpacity
          style={[styles.shareBtn, !code && { opacity: 0.5 }]}
          disabled={!code}
          onPress={() => code && void openShareNative(composeXShare(INVITE_X, code, SHARE_BASE_URL))}
        >
          <Text style={styles.shareBtnText}>𝕏 Share</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.shareBtn, !code && { opacity: 0.5 }]}
          disabled={!code}
          onPress={() => code && void openShareNative(composeTgShare(INVITE_TG, code, SHARE_BASE_URL))}
        >
          <Text style={styles.shareBtnText}>✈ Telegram</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.refStatsRow}>
        <View style={styles.refStat}>
          <Text style={[styles.refStatValue, { color: colors.energy }]}>{me ? num(me.referrals.joined) : "—"}</Text>
          <Text style={styles.refStatLabel}>Friends joined</Text>
        </View>
        <View style={styles.refStat}>
          <Text style={[styles.refStatValue, { color: colors.gold }]}>{me ? num(me.referrals.pointsEarned) : "—"}</Text>
          <Text style={styles.refStatLabel}>Points earned</Text>
        </View>
      </View>

      <Text style={styles.sectionLabel}>Have an invite code?</Text>
      <View style={styles.refRow}>
        <TextInput
          style={[styles.input, { flex: 1 }]}
          value={refInput}
          onChangeText={setRefInput}
          placeholder="Friend's code"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TouchableOpacity style={styles.refBtn} onPress={() => void saveRef()} disabled={!refInput.trim() || refBusy}>
          <Text style={styles.refBtnText}>{refBusy ? "…" : "Save"}</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { paddingHorizontal: 18, paddingTop: 8, paddingBottom: 24, alignItems: "center" },
  hero: { fontSize: 56, marginTop: 10 },
  title: { color: colors.text, fontSize: 34, fontWeight: "900", lineHeight: 38, marginTop: 6, textAlign: "center" },
  sub: { color: colors.muted, fontSize: 13, marginTop: 8, maxWidth: 280, textAlign: "center", lineHeight: 18 },
  linkRow: {
    flexDirection: "row", alignItems: "center", gap: 10, marginTop: 22, alignSelf: "stretch",
    backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: 16, paddingVertical: 6, paddingLeft: 16, paddingRight: 6,
  },
  linkText: { flex: 1, color: colors.text, fontFamily: "monospace", fontSize: 13 },
  copyBtn: { backgroundColor: colors.energy, borderRadius: 12, paddingVertical: 11, paddingHorizontal: 18 },
  copyBtnText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  shareRow: { flexDirection: "row", gap: 9, marginTop: 12, alignSelf: "stretch" },
  shareBtn: { flex: 1, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: 14, paddingVertical: 13, alignItems: "center" },
  shareBtnText: { color: colors.text, fontSize: 12, fontWeight: "700" },
  refStatsRow: { flexDirection: "row", gap: 10, marginTop: 22, alignSelf: "stretch" },
  refStat: { flex: 1, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: 18, padding: 16, alignItems: "center" },
  refStatValue: { fontFamily: "monospace", fontWeight: "700", fontSize: 26 },
  refStatLabel: { color: colors.muted, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", marginTop: 2 },
  sectionLabel: { color: colors.muted, fontSize: 10, letterSpacing: 1.4, textTransform: "uppercase", fontWeight: "700", marginTop: 22, alignSelf: "flex-start" },
  refRow: { flexDirection: "row", gap: 8, marginTop: 10, alignSelf: "stretch" },
  input: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: 14, paddingVertical: 13, paddingHorizontal: 16, color: colors.text, fontSize: 15 },
  refBtn: { backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.line, borderRadius: 14, paddingHorizontal: 18, justifyContent: "center" },
  refBtnText: { color: colors.energy, fontWeight: "700", fontSize: 13 },
});
