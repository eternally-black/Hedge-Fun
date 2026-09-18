// Profile / "You" — account stats + the invite surface. Native port of src/app/screens/
// ProfileScreen.tsx (identity header, stat tiles, sign-out) merged with InviteScreen.tsx
// (referral stats, invite link, X/TG share — here via openShareNative per docs/share-and-android.md
// §3), plus manual ref-code entry: the referral-capture baseline, same as on the login screen.
// All numbers render /api/me as-is; the economy is server-derived.
import { useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import type { CaptureRefResponse, MeResponse } from "@contract/api-types";
import { type Api } from "../api";
import { colors } from "../theme";
import { num, usd } from "../format";
import { clearRefCode, saveRefCode } from "../refCode";
import { composeTgShare, composeXShare, INVITE_TG, INVITE_X, refLink } from "@contract/share";
import { SHARE_BASE_URL } from "../../lib/config";
import { openShareNative } from "../openShareNative";
import { RealModeSwitch } from "../components/RealModeSwitch";
import { TradingWallet } from "../components/TradingWallet";

export function ProfileScreen({ me, api, onRefreshMe, onLogout, onToast }: {
  me: MeResponse | null;
  api: Api;
  onRefreshMe: () => Promise<void>;
  onLogout: () => void;
  onToast: (msg: string) => void;
}) {
  const handle = me?.user.twitter ?? (me?.user.email ? me.user.email.split("@")[0] : "degen");
  const initials = handle.slice(0, 2).toUpperCase();

  // Invite link — the user's REAL referralCode (P-11: 20% of a friend's points forever, once they
  // make their first 10 calls). refLink → the stealth /r/<code> path; display drops the scheme.
  const code = me?.user.referralCode ?? null;
  const fullLink = code ? refLink(code, SHARE_BASE_URL) : null;
  const link = fullLink ? fullLink.replace(/^https?:\/\//, "") : "…";
  const [copied, setCopied] = useState(false);

  // Manual ref-code entry (a friend invited THIS user). Stored on device, then bound right away
  // via /api/capture-ref (idempotent server-side). If the bind races/fails, the stored code rides
  // along on the next GM tap's /api/login-mark?ref=.
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
      {/* identity header */}
      <View style={styles.headerRow}>
        <View style={styles.avatar}><Text style={styles.avatarText}>{initials}</Text></View>
        <View style={{ minWidth: 0 }}>
          <Text style={styles.handle} numberOfLines={1}>{handle}</Text>
          <Text style={styles.handleSub}>Test app · stack points</Text>
        </View>
      </View>

      {/* stat tiles — straight from /api/me */}
      <View style={styles.tileGrid}>
        <Tile label="Points" value={me ? num(me.points.total) : "—"} color={colors.energy} />
        <Tile label="Virtual $" value={me ? usd(me.balanceCents) : "—"} color={colors.yes} />
        <Tile label="Cash" value={me ? usd(me.cashCents) : "—"} color={colors.yes} />
        <Tile label="Streak" value={me ? `🔥 ${me.streak.level}d` : "—"} color={colors.text} />
        <Tile label="◆ Shards" value={me ? `${me.shards}/${me.shardsPerArtifact}` : "—"} color={colors.gold} />
        <Tile label="Artifacts" value={me ? String(me.artifacts) : "—"} color={colors.gold} />
      </View>

      {/* Paper/Real switch + the trading wallet — both render nothing on a build without a wallet
          port (the Play flavor), so this screen is the same file for both stores. */}
      <RealModeSwitch me={me} api={api} onRefreshMe={onRefreshMe} onToast={onToast} />
      <TradingWallet me={me} api={api} onRefreshMe={onRefreshMe} onToast={onToast} />

      {/* invite — stats from me.referrals, share via the native opener (deep-link → tab → sheet) */}
      <Text style={styles.sectionLabel}>Invite</Text>
      <View style={styles.panel}>
        <Text style={styles.inviteTitle}>🤝 Farm faster with friends</Text>
        <Text style={styles.inviteSub}>
          You earn 20% of every friend&apos;s points — forever — once they make their first 10 calls.
        </Text>
        <View style={styles.linkRow}>
          <Text style={styles.linkText} numberOfLines={1}>{link}</Text>
          <TouchableOpacity style={styles.copyBtn} onPress={copy} disabled={!fullLink}>
            <Text style={styles.copyBtnText}>{copied ? "Copied!" : "Copy"}</Text>
          </TouchableOpacity>
        </View>
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
      </View>

      {/* manual ref-code entry — for a code THIS user received (baseline capture path) */}
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
        <TouchableOpacity style={styles.refBtn} onPress={saveRef} disabled={!refInput.trim() || refBusy}>
          <Text style={styles.refBtnText}>{refBusy ? "…" : "Save"}</Text>
        </TouchableOpacity>
      </View>

      {/* account / sign out */}
      <Text style={styles.sectionLabel}>Account</Text>
      <View style={styles.accountRow}>
        <View style={{ minWidth: 0, flex: 1 }}>
          <Text style={styles.accountLabel}>Signed in as</Text>
          <Text style={styles.accountValue} numberOfLines={1}>
            {me?.user.twitter ? `@${me.user.twitter}` : me?.user.email ?? "—"}
          </Text>
        </View>
        <TouchableOpacity style={styles.logoutBtn} onPress={onLogout}>
          <Text style={styles.logoutText}>Log out</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

function Tile({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.tileLabel}>{label}</Text>
      <Text style={[styles.tileValue, { color }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 6, paddingBottom: 24 },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 6 },
  avatar: {
    width: 58, height: 58, borderRadius: 18, backgroundColor: colors.energy,
    alignItems: "center", justifyContent: "center",
  },
  avatarText: { color: "#fff", fontSize: 26, fontWeight: "900" },
  handle: { color: colors.text, fontSize: 24, fontWeight: "900" },
  handleSub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  tileGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 16 },
  tile: {
    flexGrow: 1, flexBasis: "40%", backgroundColor: colors.panel, borderWidth: 1,
    borderColor: colors.line, borderRadius: 18, padding: 14,
  },
  tileLabel: { color: colors.muted, fontSize: 9, letterSpacing: 1.2, textTransform: "uppercase" },
  tileValue: { fontFamily: "monospace", fontWeight: "700", fontSize: 24, marginTop: 3 },
  sectionLabel: {
    color: colors.muted, fontSize: 10, letterSpacing: 1.4, textTransform: "uppercase",
    fontWeight: "700", marginTop: 22,
  },
  panel: {
    marginTop: 10, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line,
    borderRadius: 16, padding: 14, alignItems: "center",
  },
  inviteTitle: { color: colors.text, fontSize: 18, fontWeight: "900" },
  inviteSub: { color: colors.muted, fontSize: 12, textAlign: "center", marginTop: 6, lineHeight: 17 },
  linkRow: {
    flexDirection: "row", alignItems: "center", gap: 10, marginTop: 14, alignSelf: "stretch",
    backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.line, borderRadius: 14,
    paddingVertical: 6, paddingLeft: 14, paddingRight: 6,
  },
  linkText: { flex: 1, color: colors.text, fontFamily: "monospace", fontSize: 13 },
  copyBtn: { backgroundColor: colors.energy, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 16 },
  copyBtnText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  shareRow: { flexDirection: "row", gap: 9, marginTop: 12, alignSelf: "stretch" },
  shareBtn: {
    flex: 1, backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.line,
    borderRadius: 14, paddingVertical: 13, alignItems: "center",
  },
  shareBtnText: { color: colors.text, fontSize: 12, fontWeight: "700" },
  refStatsRow: { flexDirection: "row", gap: 10, marginTop: 12, alignSelf: "stretch" },
  refStat: {
    flex: 1, backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.line,
    borderRadius: 14, padding: 14, alignItems: "center",
  },
  refStatValue: { fontFamily: "monospace", fontWeight: "700", fontSize: 22 },
  refStatLabel: { color: colors.muted, fontSize: 9, letterSpacing: 1, textTransform: "uppercase", marginTop: 3 },
  refRow: { flexDirection: "row", gap: 8, marginTop: 10 },
  input: {
    backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: 14,
    paddingVertical: 13, paddingHorizontal: 16, color: colors.text, fontSize: 15,
  },
  refBtn: {
    backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.line, borderRadius: 14,
    paddingHorizontal: 18, justifyContent: "center",
  },
  refBtnText: { color: colors.energy, fontWeight: "700", fontSize: 13 },
  accountRow: {
    marginTop: 10, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line,
    borderRadius: 14, paddingVertical: 12, paddingHorizontal: 14, flexDirection: "row",
    alignItems: "center", gap: 10,
  },
  accountLabel: { color: colors.muted, fontSize: 10, letterSpacing: 1, textTransform: "uppercase" },
  accountValue: { color: colors.text, fontSize: 13, fontWeight: "600", marginTop: 2 },
  logoutBtn: {
    flexShrink: 0, backgroundColor: "rgba(255,59,78,0.12)", borderWidth: 1,
    borderColor: "rgba(255,59,78,0.4)", borderRadius: 12, paddingVertical: 9, paddingHorizontal: 16,
  },
  logoutText: { color: colors.no, fontWeight: "700", fontSize: 13 },
});
