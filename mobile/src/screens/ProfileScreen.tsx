// Profile / "You" — native port of src/app/screens/ProfileScreen.tsx: identity header, the web's four
// stat tiles, the MORE menu (History / Vault / Invite), dev tools, the real-money block, the trading
// wallet, the account + 𝕏 link/unlink rows and the founder support contacts. The invite surface and
// the manual ref-code entry live on InviteScreen (reached from the MORE menu), as on the web.
import { useEffect, useState } from "react";
import { Linking, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useLinkWithOAuth, usePrivy, useUnlinkOAuth } from "@privy-io/expo";
import type { MeResponse } from "@contract/api-types";
import { type Api, statusOf } from "../api";
import { colors } from "../theme";
import { num, usd } from "../format";
import { RealModeSwitch } from "../components/RealModeSwitch";
import { RealPredictionsSetup } from "../components/RealPredictionsSetup";
import { TradingWallet } from "../components/TradingWallet";

// Founder support contacts — external links. Hoisted so the list isn't re-created per render.
const SUPPORT_CONTACTS = [
  { label: "Telegram", handle: "@SirHi_Crypto", href: "https://t.me/SirHi_Crypto" },
  { label: "𝕏 (Twitter)", handle: "@SirHi_Talk", href: "https://x.com/SirHi_Talk" },
] as const;

// Vault, History and Invite are not tabs (four tabs max) and are reached from here.
const MORE: { key: "history" | "vault" | "invite"; glyph: string; label: string; hint: string }[] = [
  { key: "history", glyph: "≡", label: "History", hint: "Open and settled calls" },
  { key: "vault", glyph: "◆", label: "Vault", hint: "Shards and artifacts" },
  { key: "invite", glyph: "＋", label: "Invite", hint: "Earn 20% of a friend's points" },
];

type TwitterAccount = { type: string; username?: string | null; subject?: string };

export function ProfileScreen({ me, api, onRefreshMe, onLogout, onToast, onNav, onOpenHistory }: {
  me: MeResponse | null;
  api: Api;
  onRefreshMe: () => Promise<void>;
  onLogout: () => void;
  onToast: (msg: string) => void;
  onNav: (s: "vault" | "invite") => void;
  onOpenHistory: () => void;
}) {
  const handle = me?.user.twitter ?? (me?.user.email ? me.user.email.split("@")[0] : "degen");
  const initials = handle.slice(0, 2).toUpperCase();
  const [resetting, setResetting] = useState(false);

  // X (Twitter) link/unlink. Linking opens Privy's OAuth flow; on success the handle is pushed into
  // our DB (/api/link/sync — identity is only extracted at first login) and /api/me re-read. Unlink
  // detaches in Privy first, then /api/link/unlink nulls our column.
  const [busyX, setBusyX] = useState<null | "link" | "unlink">(null);
  const [xError, setXError] = useState<string | null>(null);
  const { user: privyUser } = usePrivy();
  const { link } = useLinkWithOAuth();
  const { unlinkOAuth } = useUnlinkOAuth();
  const twitterAccount = (privyUser?.linked_accounts ?? []).find((a) => a.type === "twitter_oauth") as TwitterAccount | undefined;

  // Back-fill our DB from Privy's reconciled state; idempotent (/api/link/sync no-ops once stored).
  const syncTwitter = async () => {
    try {
      await api("/api/link/sync", { method: "POST" });
      await onRefreshMe();
    } catch (e) {
      setXError(
        statusOf(e) === 409
          ? "That X account is already linked to another HedgeFun account — contact support."
          : "Couldn't link X. Try again.",
      );
    } finally {
      setBusyX(null);
    }
  };

  // Linked in Privy but not in our DB (a flow that returned without its callback) → back-fill once.
  // Deps are primitives; once the handle lands the condition flips false, so this can't loop.
  const privyTwitter = twitterAccount?.username ?? null;
  useEffect(() => {
    if (privyTwitter && me && !me.user.twitter) void syncTwitter();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [privyTwitter, me?.user.twitter]);

  const startLink = async () => {
    setXError(null);
    setBusyX("link");
    // Already linked in Privy but not synced → don't re-open OAuth (Privy throws "already linked").
    if (twitterAccount) { void syncTwitter(); return; }
    try {
      await link({ provider: "twitter" });
      await syncTwitter();
    } catch {
      setXError("Couldn't link X. Try again.");
      setBusyX(null);
    }
  };
  const startUnlink = async () => {
    setXError(null);
    setBusyX("unlink");
    try {
      // No subject = nothing to unlink in Privy; bail rather than clear our column (a desync).
      const subject = twitterAccount?.subject;
      if (!subject) throw new Error("no twitter subject");
      await unlinkOAuth({ provider: "twitter", subject });
      await api("/api/link/unlink", { method: "POST" });
      await onRefreshMe();
    } catch {
      setXError("Couldn't unlink X. Try again.");
    } finally {
      setBusyX(null);
    }
  };

  const resetDeck = async () => {
    setResetting(true);
    try {
      await api("/api/dev/reset-deck", { method: "POST" });
      await onRefreshMe();
    } catch (e) {
      console.error(e);
    } finally {
      setResetting(false);
    }
  };

  const emailSignup = me?.user.authProvider === "EMAIL";

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <View style={styles.headerRow}>
        <View style={styles.avatar}><Text style={styles.avatarText}>{initials}</Text></View>
        <View style={{ minWidth: 0, flex: 1 }}>
          <Text style={styles.handle} numberOfLines={1}>{handle}</Text>
          <Text style={styles.handleSub}>Test app · stack points</Text>
        </View>
      </View>

      <View style={styles.tileGrid}>
        <Tile label="Points" value={me ? num(me.points.total) : "—"} color={colors.energy} />
        <Tile label="Virtual $" value={me ? usd(me.balanceCents) : "—"} color={colors.yes} />
        <Tile label="Streak" value={me ? `🔥 ${me.streak.level}d` : "—"} color={colors.text} />
        <Tile label="◆ Shards" value={me ? `${me.shards}/${me.shardsPerArtifact}` : "—"} color={colors.gold} />
      </View>

      <View style={styles.morePanel}>
        {MORE.map((m, i) => (
          <TouchableOpacity
            key={m.key}
            style={[styles.moreRow, i > 0 && styles.moreRowDivider]}
            onPress={() => (m.key === "history" ? onOpenHistory() : onNav(m.key))}
            accessibilityRole="button"
          >
            <Text style={styles.moreGlyph}>{m.glyph}</Text>
            <View style={{ minWidth: 0, flex: 1 }}>
              <Text style={styles.moreLabel}>{m.label}</Text>
              <Text style={styles.moreHint}>{m.hint}</Text>
            </View>
            <Text style={styles.moreChevron}>›</Text>
          </TouchableOpacity>
        ))}
      </View>

      {me?.dev ? (
        <View style={styles.devPanel}>
          <Text style={styles.devLabel}>Dev tools</Text>
          <Text style={styles.devBody}>Unlimited skips are on. Reset re-deals every market.</Text>
          <TouchableOpacity style={[styles.devBtn, resetting && { opacity: 0.6 }]} onPress={() => void resetDeck()} disabled={resetting}>
            <Text style={styles.devBtnText}>{resetting ? "Resetting…" : "↻ Reset & reload deck"}</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {/* The real-money block — both render nothing on a build without a wallet port (Play). */}
      <RealModeSwitch me={me} api={api} onRefreshMe={onRefreshMe} onToast={onToast} />
      <RealPredictionsSetup me={me} api={api} onRefreshMe={onRefreshMe} onToast={onToast} />

      {/* The phone's TradingWallet is the web's linked-wallet list (it renders its own heading). */}
      <TradingWallet me={me} api={api} onRefreshMe={onRefreshMe} onToast={onToast} />

      <Text style={styles.sectionLabel}>Account</Text>
      <View style={styles.accountRow}>
        <View style={{ minWidth: 0, flex: 1 }}>
          <Text style={styles.accountLabel}>Signed in as</Text>
          <Text style={styles.accountValue} numberOfLines={1}>
            {me?.user.twitter ? `@${me.user.twitter}` : me?.user.email ?? "—"}
          </Text>
        </View>
        <TouchableOpacity style={styles.dangerBtn} onPress={onLogout}>
          <Text style={styles.dangerText}>Log out</Text>
        </TouchableOpacity>
      </View>

      {/* 𝕏: linked → the handle (+ Unlink for email-signup users; a Twitter-signup user can't unlink
          their login). Not linked → Link (email users only). */}
      <View style={styles.accountRow}>
        <View style={{ minWidth: 0, flex: 1 }}>
          <Text style={styles.accountLabel}>𝕏 Account</Text>
          <Text style={styles.accountValue} numberOfLines={1}>{me?.user.twitter ? `@${me.user.twitter}` : "Not connected"}</Text>
        </View>
        {emailSignup ? (
          me?.user.twitter ? (
            <TouchableOpacity style={[styles.dangerBtn, busyX && { opacity: 0.6 }]} onPress={() => void startUnlink()} disabled={!!busyX}>
              <Text style={styles.dangerText}>{busyX === "unlink" ? "Unlinking…" : "Unlink"}</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={[styles.linkBtn, busyX && { opacity: 0.6 }]} onPress={() => void startLink()} disabled={!!busyX}>
              <Text style={styles.linkText}>{busyX === "link" ? "Linking…" : "Link 𝕏"}</Text>
            </TouchableOpacity>
          )
        ) : null}
      </View>
      {xError ? <Text style={styles.xError}>{xError}</Text> : null}

      <Text style={styles.sectionLabel}>Support</Text>
      <View style={{ marginTop: 10, gap: 10 }}>
        {SUPPORT_CONTACTS.map((c) => (
          <TouchableOpacity key={c.href} style={styles.supportRow} onPress={() => void Linking.openURL(c.href)} accessibilityRole="link">
            <View style={{ minWidth: 0, flex: 1 }}>
              <Text style={styles.accountLabel}>{c.label}</Text>
              <Text style={styles.accountValue} numberOfLines={1}>{c.handle}</Text>
            </View>
            <Text style={styles.supportArrow}>↗</Text>
          </TouchableOpacity>
        ))}
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
  avatar: { width: 58, height: 58, borderRadius: 18, backgroundColor: colors.energy, alignItems: "center", justifyContent: "center" },
  avatarText: { color: "#fff", fontSize: 26, fontWeight: "900" },
  handle: { color: colors.text, fontSize: 24, fontWeight: "900" },
  handleSub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  tileGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 16 },
  tile: { flexGrow: 1, flexBasis: "40%", backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: 18, padding: 14 },
  tileLabel: { color: colors.muted, fontSize: 9, letterSpacing: 1.2, textTransform: "uppercase" },
  tileValue: { fontFamily: "monospace", fontWeight: "700", fontSize: 22, marginTop: 3 },
  morePanel: { marginTop: 16, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: 14, overflow: "hidden" },
  moreRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 14 },
  moreRowDivider: { borderTopWidth: 1, borderTopColor: colors.line },
  moreGlyph: { color: colors.muted, fontSize: 18, width: 24, textAlign: "center" },
  moreLabel: { color: colors.text, fontSize: 14, fontWeight: "700" },
  moreHint: { color: colors.muted, fontSize: 12, marginTop: 1 },
  moreChevron: { color: colors.muted, fontSize: 18 },
  devPanel: { marginTop: 22, borderWidth: 1, borderStyle: "dashed", borderColor: colors.skip, borderRadius: 14, padding: 14, backgroundColor: "rgba(77,155,255,0.08)" },
  devLabel: { color: colors.skip, fontSize: 10, letterSpacing: 1.4, textTransform: "uppercase", fontWeight: "700" },
  devBody: { color: colors.muted, fontSize: 12, marginTop: 4 },
  devBtn: { marginTop: 10, backgroundColor: colors.skip, borderRadius: 12, paddingVertical: 12, alignItems: "center" },
  devBtnText: { color: "#04121f", fontWeight: "700", fontSize: 13 },
  sectionLabel: { color: colors.muted, fontSize: 10, letterSpacing: 1.4, textTransform: "uppercase", fontWeight: "700", marginTop: 22 },
  accountRow: {
    marginTop: 10, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: 14,
    paddingVertical: 12, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 10,
  },
  accountLabel: { color: colors.muted, fontSize: 10, letterSpacing: 1, textTransform: "uppercase" },
  accountValue: { color: colors.text, fontSize: 13, fontWeight: "600", marginTop: 2 },
  dangerBtn: { flexShrink: 0, backgroundColor: "rgba(255,59,78,0.12)", borderWidth: 1, borderColor: "rgba(255,59,78,0.4)", borderRadius: 12, paddingVertical: 9, paddingHorizontal: 16 },
  dangerText: { color: colors.no, fontWeight: "700", fontSize: 13 },
  linkBtn: { flexShrink: 0, backgroundColor: "rgba(255,61,205,0.16)", borderWidth: 1, borderColor: "rgba(255,61,205,0.45)", borderRadius: 12, paddingVertical: 9, paddingHorizontal: 16 },
  linkText: { color: colors.energy, fontWeight: "700", fontSize: 13 },
  xError: { color: colors.no, fontSize: 12, marginTop: 8 },
  supportRow: {
    backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: 14,
    paddingVertical: 12, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 12,
  },
  supportArrow: { color: colors.muted, fontSize: 16 },
});
