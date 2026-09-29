// The Vault — native port of src/app/screens/VaultScreen.tsx: the shard→artifact progress ring,
// artifacts owned, and the Card Designs shop. The shop spends artifacts on cosmetic card skins via
// /api/skins; tapping a tile opens a preview-before-spend overlay on the user's real next card.
import { useCallback, useMemo, useState } from "react";
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import type { DeckCard as DeckCardT, MeResponse } from "@contract/api-types";
import { type Api } from "../api";
import { colors, withAlpha } from "../theme";
import { SKINS, skinById, SkinBackground } from "../skins";
import { CardFace } from "../components/DeckCard";

export function VaultScreen({ me, api, onRefreshMe, previewCard }: {
  me: MeResponse | null;
  api: Api;
  onRefreshMe: () => Promise<void>;
  previewCard?: DeckCardT;
}) {
  const [busy, setBusy] = useState(false);
  const [previewSkin, setPreviewSkin] = useState<string | null>(null);
  // One frozen "now" for the preview (lazy init = pure). A preview card doesn't need a live tick.
  const [nowMs] = useState(() => Date.now());
  const shards = me?.shards ?? 0;
  const per = me?.shardsPerArtifact ?? 20;
  const artifacts = me?.artifacts ?? 0;
  const owned = me?.skins.owned ?? ["classic"];
  const equipped = me?.skins.equipped ?? "classic";
  const circumference = 326.7;
  const dash = `${((Math.min(shards, per) / per) * circumference).toFixed(0)} ${circumference}`;

  // Unlock spends artifacts (then equips); equip just switches. Both POST /api/skins, then refresh
  // /api/me so balances + the live deck repaint, and close the preview.
  const act = useCallback(async (action: "unlock" | "equip", skinId: string) => {
    setBusy(true);
    try {
      await api("/api/skins", { method: "POST", body: JSON.stringify({ action, skinId }) });
      await onRefreshMe();
      setPreviewSkin(null);
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  }, [api, onRefreshMe]);

  // The card the preview renders the skin on: the user's real next deck card when available, else a
  // representative sample.
  const previewBase = useMemo<DeckCardT>(
    () =>
      previewCard ?? ({
        id: "sample",
        question: "Will Bitcoin close above $80,000 this week?",
        category: null,
        outcomeYesLabel: "Yes",
        outcomeNoLabel: "No",
        yesPriceBp: 5200,
        noPriceBp: 4800,
        resolutionDeadline: new Date(nowMs + 4 * 3_600_000).toISOString(),
      } as DeckCardT),
    [previewCard, nowMs],
  );

  return (
    <>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <Text style={styles.title}>The Vault</Text>
        <Text style={styles.sub}>Correct calls drop shards. {per} shards forge 1 artifact.</Text>

        <View style={styles.ringWrap}>
          <Svg viewBox="0 0 120 120" style={[StyleSheet.absoluteFill, { transform: [{ rotate: "-90deg" }] }]}>
            <Circle cx={60} cy={60} r={52} fill="none" stroke={colors.panel2} strokeWidth={10} />
            <Circle cx={60} cy={60} r={52} fill="none" stroke={colors.gold} strokeWidth={10} strokeLinecap="round" strokeDasharray={dash} />
          </Svg>
          <View style={{ alignItems: "center" }}>
            <Text style={styles.ringGem}>◆</Text>
            <Text style={styles.ringCount}>{shards}/{per}</Text>
          </View>
        </View>
        <Text style={styles.more}>{Math.max(0, per - shards)} more shards to forge your next artifact</Text>

        <Text style={styles.sectionLabel}>Artifacts</Text>
        <View style={styles.artRow}>
          {Array.from({ length: 3 }).map((_, i) => {
            const isOwned = i < artifacts;
            return (
              <View key={i} style={[styles.art, isOwned ? styles.artOwned : styles.artLocked]}>
                <Text style={{ fontSize: 30 }}>{isOwned ? "🛡" : "＋"}</Text>
                <Text style={[styles.artLabel, { color: isOwned ? colors.gold : colors.muted }]}>{isOwned ? "Artifact" : "Locked"}</Text>
              </View>
            );
          })}
        </View>

        {/* Card Designs shop — spend artifacts on deck looks. Lives inside the Vault. */}
        <View style={styles.shopHead}>
          <View style={{ flex: 1 }}>
            <Text style={styles.shopTitle}>Card Designs</Text>
            <Text style={styles.shopSub}>Spend artifacts on new deck looks. Tap to preview before you buy.</Text>
          </View>
          <View style={styles.artPill}>
            <Text style={{ fontSize: 14 }}>🛡</Text>
            <Text style={styles.artPillText}>{artifacts}</Text>
          </View>
        </View>

        <View style={styles.grid}>
          {SKINS.map((sk) => {
            const isEquipped = equipped === sk.id;
            const isOwned = owned.includes(sk.id);
            const affordable = artifacts >= sk.cost;
            const badge = isEquipped ? "Equipped" : isOwned ? "Owned" : `🛡 ${sk.cost}`;
            const badgeBg = isEquipped ? colors.yes : !isOwned && affordable ? colors.gold : "rgba(0,0,0,0.5)";
            const badgeColor = isEquipped ? "#04210f" : !isOwned && affordable ? "#1a1205" : "#fff";
            return (
              <TouchableOpacity
                key={sk.id}
                style={[styles.tile, { borderColor: isEquipped ? withAlpha(colors.yes, "8c") : colors.line }]}
                onPress={() => setPreviewSkin(sk.id)}
                accessibilityRole="button"
                accessibilityLabel={`${sk.name} card design`}
              >
                <View style={styles.tileArt}>
                  <SkinBackground skinId={sk.id} categoryColor={sk.accent} isFootball={false} scrim={false} />
                  <View style={[styles.badge, { backgroundColor: badgeBg }]}>
                    <Text style={[styles.badgeText, { color: badgeColor }]}>{badge}</Text>
                  </View>
                </View>
                <View style={styles.tileBody}>
                  <Text style={styles.tileName}>{sk.name}</Text>
                  <Text style={styles.tileBlurb}>{sk.blurb}</Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      </ScrollView>

      <Modal visible={!!previewSkin} transparent animationType="fade" onRequestClose={() => setPreviewSkin(null)}>
        {previewSkin ? (
          <PreviewOverlay
            skinId={previewSkin}
            card={previewBase}
            owned={owned}
            equipped={equipped}
            artifacts={artifacts}
            per={per}
            busy={busy}
            onClose={() => setPreviewSkin(null)}
            onUnlock={() => void act("unlock", previewSkin)}
            onEquip={() => void act("equip", previewSkin)}
          />
        ) : null}
      </Modal>
    </>
  );
}

// Preview-before-spend: the selected skin on a real card stamped PREVIEW, with a state-driven CTA
// (Unlock / Equip / Equipped / Need more artifacts). The preview itself is always free.
function PreviewOverlay({ skinId, card, owned, equipped, artifacts, per, busy, onClose, onUnlock, onEquip }: {
  skinId: string;
  card: DeckCardT;
  owned: string[];
  equipped: string;
  artifacts: number;
  per: number;
  busy: boolean;
  onClose: () => void;
  onUnlock: () => void;
  onEquip: () => void;
}) {
  const sk = skinById(skinId);
  if (!sk) return null;
  const isEquipped = equipped === sk.id;
  const isOwned = owned.includes(sk.id);
  const affordable = artifacts >= sk.cost;

  let label: string, bg: string, fg: string, hint: string;
  let onCta: (() => void) | undefined;
  if (isEquipped) {
    label = "Equipped ✓"; bg = colors.panel2; fg = colors.muted; hint = "This design is live on your deck.";
  } else if (isOwned) {
    label = "Equip design"; bg = colors.energy; fg = "#fff"; hint = "You own this design — make it active."; onCta = onEquip;
  } else if (affordable) {
    label = `Unlock for 🛡 ${sk.cost}`; bg = colors.gold; fg = "#1a1205"; hint = `Spends ${sk.cost} of your ${artifacts} artifacts · equips instantly.`; onCta = onUnlock;
  } else {
    label = `Need 🛡 ${sk.cost}`; bg = colors.panel2; fg = colors.muted; hint = `You have ${artifacts}. Forge ${per} shards to mint an artifact.`;
  }
  const disabled = busy || !onCta;

  return (
    <View style={styles.overlay}>
      <View style={styles.overlayHead}>
        <Text style={styles.overlayKicker}>Preview design</Text>
        <TouchableOpacity onPress={onClose} style={styles.overlayClose} accessibilityLabel="Close">
          <Text style={{ color: colors.text, fontSize: 14 }}>✕</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.overlayBody}>
        <View style={styles.previewCard}>
          {/* A skin preview, not a live card: the paper stake draws it, and there is nothing to edit. */}
          <CardFace card={card} skinId={sk.id} stakeCents={1000} />
          <View style={styles.previewStamp}><Text style={styles.previewStampText}>PREVIEW</Text></View>
        </View>
        <Text style={styles.previewName}>{sk.name}</Text>
        <Text style={styles.previewBlurb}>{sk.blurb}</Text>
      </View>
      <View style={styles.overlayFoot}>
        <TouchableOpacity onPress={onCta} disabled={disabled} style={[styles.cta, { backgroundColor: bg }, busy && { opacity: 0.6 }]}>
          <Text style={[styles.ctaText, { color: fg }]}>{label}</Text>
        </TouchableOpacity>
        <Text style={styles.ctaHint}>{hint}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { paddingHorizontal: 18, paddingTop: 8, paddingBottom: 24, alignItems: "center" },
  title: { color: colors.text, fontSize: 30, fontWeight: "900", marginTop: 6 },
  sub: { color: colors.muted, fontSize: 12, marginTop: 2, textAlign: "center" },
  ringWrap: { width: 150, height: 150, marginTop: 20, alignItems: "center", justifyContent: "center" },
  ringGem: { fontSize: 40, color: colors.gold, textShadowColor: colors.gold, textShadowRadius: 12 },
  ringCount: { fontFamily: "monospace", fontWeight: "700", fontSize: 20, color: colors.gold, marginTop: 2 },
  more: { color: colors.muted, fontSize: 13, marginTop: 6 },
  sectionLabel: { alignSelf: "flex-start", marginTop: 22, fontSize: 10, letterSpacing: 1.4, textTransform: "uppercase", color: colors.muted, fontWeight: "700" },
  artRow: { flexDirection: "row", gap: 10, marginTop: 10, alignSelf: "stretch" },
  art: { flex: 1, aspectRatio: 1, borderRadius: 18, alignItems: "center", justifyContent: "center", gap: 4 },
  artOwned: { backgroundColor: withAlpha(colors.gold, "26"), borderWidth: 1, borderColor: withAlpha(colors.gold, "66") },
  artLocked: { backgroundColor: colors.panel, borderWidth: 1, borderStyle: "dashed", borderColor: colors.line, opacity: 0.5 },
  artLabel: { fontSize: 10, fontWeight: "700" },
  shopHead: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 26, alignSelf: "stretch" },
  shopTitle: { color: colors.text, fontSize: 22, fontWeight: "900" },
  shopSub: { color: colors.muted, fontSize: 11, marginTop: 2 },
  artPill: {
    flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: withAlpha(colors.gold, "24"),
    borderWidth: 1, borderColor: withAlpha(colors.gold, "66"), paddingVertical: 7, paddingHorizontal: 12, borderRadius: 22,
  },
  artPillText: { fontFamily: "monospace", fontWeight: "700", color: colors.gold, fontSize: 15 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 11, marginTop: 13, alignSelf: "stretch" },
  tile: { width: "48%", flexGrow: 1, borderRadius: 16, overflow: "hidden", borderWidth: 1.5, backgroundColor: colors.panel },
  tileArt: { height: 116, overflow: "hidden" },
  badge: { position: "absolute", top: 8, right: 8, paddingVertical: 3, paddingHorizontal: 9, borderRadius: 20 },
  badgeText: { fontFamily: "monospace", fontWeight: "700", fontSize: 11 },
  tileBody: { paddingTop: 10, paddingHorizontal: 11, paddingBottom: 12 },
  tileName: { color: colors.text, fontWeight: "700", fontSize: 14 },
  tileBlurb: { color: colors.muted, fontSize: 11, marginTop: 2, lineHeight: 14 },

  overlay: { flex: 1, backgroundColor: "rgba(4,4,8,0.9)" },
  overlayHead: { flexDirection: "row", alignItems: "center", paddingTop: 18, paddingHorizontal: 18, paddingBottom: 4 },
  overlayKicker: { fontSize: 10, letterSpacing: 2.2, textTransform: "uppercase", color: colors.muted, fontWeight: "700" },
  overlayClose: {
    marginLeft: "auto", width: 34, height: 34, borderRadius: 17, backgroundColor: colors.panel,
    borderWidth: 1, borderColor: colors.line, alignItems: "center", justifyContent: "center",
  },
  overlayBody: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 22, paddingVertical: 4 },
  previewCard: { width: 262, maxWidth: "100%", aspectRatio: 0.62, borderRadius: 24, overflow: "hidden", borderWidth: 1, borderColor: colors.line, backgroundColor: colors.panel2 },
  previewStamp: { position: "absolute", top: 12, left: 12, backgroundColor: colors.energy, paddingVertical: 3, paddingHorizontal: 10, borderRadius: 8, transform: [{ rotate: "-4deg" }] },
  previewStampText: { color: "#fff", fontSize: 12, letterSpacing: 0.7, fontWeight: "900" },
  previewName: { color: colors.text, fontSize: 24, fontWeight: "900", marginTop: 15 },
  previewBlurb: { color: colors.muted, fontSize: 12, marginTop: 2, maxWidth: 280, textAlign: "center" },
  overlayFoot: { paddingTop: 4, paddingHorizontal: 20, paddingBottom: 20 },
  cta: { width: "100%", padding: 15, borderRadius: 16, alignItems: "center" },
  ctaText: { fontSize: 20, fontWeight: "900" },
  ctaHint: { textAlign: "center", marginTop: 9, fontSize: 11, color: colors.muted },
});
