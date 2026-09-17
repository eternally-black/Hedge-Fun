// Hedge suggestion card — the native port of the web HedgeScreen's HedgeCard (src/app/screens/
// HedgeScreen.tsx), extended for S2 + the discovery fallback. Deck-card visual language (panel,
// category chip, ⏱ countdown, odds split) PLUS the hedge chrome: the kind badge (an S1-proxy carries
// a visible "Proxy · basis risk" label, a discovery card a visible "not a hedge" label — spec §2,
// neither may ever read as a plain hedge), the hedge context line ("Hedges your SOL…" / "bets
// AGAINST {matchedEntity}"), the avg-buy-cost narrative rendered ONLY when the server sends one
// (D4 degradation — no placeholder), and accept/dismiss in place of the two-sided bet buttons.
// The accept button shows the PROPOSED stake; the confirmation banner shows the stake the server
// RETURNED (it may be clamped to free Cash — said out loud when it happens).
import { memo } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { HedgeSuggestion } from "@contract/api-types";
import { colors, withAlpha } from "../theme";
import { catOf, cents, countdown, displayQuestion, sideLabels, usd, winPayout } from "../format";

// `placing` = the D9 optimistic state: the tap flipped the card to accepted instantly and the POST is
// still in flight. Success reconciles to the server-returned stakeCents/already; any failure removes
// the entry (card returns to actionable) + a non-blocking retry toast.
export type AcceptedInfo = { stakeCents: number; already: boolean; placing: boolean };

export const HedgeCard = memo(function HedgeCard({
  s,
  acceptedInfo,
  busy,
  nowMs,
  onAccept,
  onDismiss,
}: {
  s: HedgeSuggestion;
  acceptedInfo: AcceptedInfo | undefined;
  busy: boolean;
  nowMs: number; // shared screen clock — keeps Date.now() out of render
  onAccept: (s: HedgeSuggestion) => void;
  onDismiss: (s: HedgeSuggestion) => void;
  // Impression telemetry lives in the screen's ImpressionArea wrapper now (F9 — fires on first viewport
  // overlap, not mount), so this card is impression-agnostic.
}) {
  // F13: a fallback card is discovery whether the server flags isDiscovery OR only tags kind:"fallback"
  // — either alone must never render as a plain hedge. Key every discovery branch off both.
  const discovery = s.isDiscovery === true || s.kind === "fallback";
  const cat = catOf(s);
  const labels = sideLabels(s);
  const cd = countdown(s.resolutionDeadline, nowMs);
  const sideColor = s.side === "YES" ? colors.yes : colors.no;
  const sidePriceBp = s.side === "YES" ? s.yesPriceBp : s.noPriceBp;
  const payout = winPayout(sidePriceBp, s.proposedStakeCents);

  return (
    <View style={styles.card}>
      {/* kind badge + category + countdown */}
      <View style={styles.topRow}>
        <KindBadge s={s} />
        <View style={styles.badge}>
          <View style={[styles.badgeDot, { backgroundColor: cat.color }]} />
          <Text style={styles.badgeText}>{cat.label}</Text>
        </View>
        <View style={[styles.badge, styles.timerBadge, cd.urgent && styles.badgeUrgent]}>
          <Text style={styles.badgeText}>⏱ <Text style={cd.urgent ? styles.timerUrgent : styles.timer}>{cd.text}</Text></Text>
        </View>
      </View>

      {/* question + hedge context (discovery cards get NO hedge framing at all) */}
      <View style={styles.middle}>
        <Text style={styles.question} numberOfLines={4}>{displayQuestion(s)}</Text>
        {s.kind === "S2" && s.matchedEntity ? (
          <Text style={styles.context}>
            Bets AGAINST <Text style={styles.contextStrong}>{s.matchedEntity}</Text>
            {s.league ? ` · ${s.league}` : ""} — you win if they lose
          </Text>
        ) : !discovery && s.hedgedAsset ? (
          <Text style={styles.context}>
            Hedges your <Text style={styles.contextStrong}>{s.hedgedAsset}</Text> · {usd(s.hedgedNotionalCents)} exposure
          </Text>
        ) : null}
        {/* D4 degradation: the avg-buy-cost line renders ONLY when the server sends one. */}
        {s.avgBuyCostNarrative && <Text style={styles.narrative}>{s.avgBuyCostNarrative}</Text>}
      </View>

      {/* odds split — same visual language as the deck card */}
      <View>
        <View style={styles.oddsRow}>
          <Text style={[styles.oddsSide, { color: colors.no }]} numberOfLines={1}>{labels.no} {cents(s.noPriceBp)}</Text>
          <Text style={[styles.oddsSide, { color: colors.yes }]} numberOfLines={1}>{cents(s.yesPriceBp)} {labels.yes}</Text>
        </View>
        <View style={styles.oddsBar}>
          <View style={{ width: `${s.noPriceBp / 100}%`, backgroundColor: colors.no, height: "100%" }} />
          <View style={{ flex: 1, backgroundColor: colors.yes, height: "100%" }} />
        </View>
      </View>

      {/* actions — or the confirmation banner once accepted */}
      {acceptedInfo ? (
        <AcceptedBanner s={s} info={acceptedInfo} />
      ) : (
        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.dismissBtn, busy && { opacity: 0.5 }]}
            onPress={() => onDismiss(s)}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
          >
            <Text style={styles.dismissText}>Dismiss</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.acceptBtn,
              { backgroundColor: withAlpha(sideColor, "29"), borderColor: withAlpha(sideColor, "80") },
              busy && { opacity: 0.5 },
            ]}
            onPress={() => onAccept(s)}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={`${discovery ? "Bet" : "Hedge"} ${usd(s.proposedStakeCents)} on ${s.sideLabel}`}
          >
            {busy ? (
              <Text style={[styles.acceptTitle, { color: sideColor }]}>Placing…</Text>
            ) : (
              <>
                <Text style={[styles.acceptTitle, { color: sideColor }]} numberOfLines={1}>
                  {discovery ? "Bet" : "Hedge"} {usd(s.proposedStakeCents)} on {s.sideLabel}
                </Text>
                <Text style={styles.acceptSub}>
                  to win <Text style={{ color: sideColor, fontFamily: "monospace", fontWeight: "700" }}>{usd(payout)}</Text>
                </Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      )}

      {/* honesty footnote — proxy is labeled a proxy, discovery is labeled NOT a hedge, and sizing
          never claims hedge-math equivalence (sizing percentages are product rules, spec §2) */}
      <Text style={styles.footnote}>
        {s.isProxy
          ? "Proxy — shorts SOL, not your exact tokens. Basis risk · sizing is a product rule, not hedge math."
          : discovery
            ? "Discovery — not a hedge. Just a contested market to explore."
            : "Paper bet · sizing is a product rule, not hedge math."}
      </Text>
    </View>
  );
});

// The kind badge the spec insists on: a proxy is labeled a proxy (basis risk), a discovery card is
// labeled NOT a hedge — neither may ever pass as a plain "hedge".
function KindBadge({ s }: { s: HedgeSuggestion }) {
  // F13: discovery keys off the flag OR kind:"fallback" — never mislabel a fallback as a plain hedge.
  const discovery = s.isDiscovery === true || s.kind === "fallback";
  const color = discovery ? colors.muted : s.isProxy ? "#ff8a3d" : s.kind === "S2" ? colors.skip : colors.yes;
  const label = discovery
    ? "Discovery · not a hedge"
    : s.isProxy
      ? "Proxy · basis risk"
      : s.kind === "S2"
        ? "Life hedge"
        : "Direct hedge";
  return (
    <View style={[styles.kindBadge, { backgroundColor: withAlpha(color, "2e"), borderColor: withAlpha(color, "8c") }]}>
      <Text style={[styles.kindBadgeText, { color }]}>{label}</Text>
    </View>
  );
}

// Bet confirmation: shows the stake the SERVER actually locked (it may be clamped below the
// proposed size to available Cash — said out loud when it happens).
function AcceptedBanner({ s, info }: { s: HedgeSuggestion; info: AcceptedInfo }) {
  const color = s.side === "YES" ? colors.yes : colors.no;
  // D9 optimistic: the tap already flipped the card here; the POST reconciles this in the background.
  if (info.placing) {
    return (
      <View style={[styles.acceptedBanner, { backgroundColor: withAlpha(color, "1f"), borderColor: withAlpha(color, "66") }]}>
        <Text style={styles.acceptedText}>
          Placing <Text style={{ color, fontFamily: "monospace", fontWeight: "700" }}>{usd(s.proposedStakeCents)}</Text>
          {" on "}
          <Text style={{ color, fontWeight: "800" }}>{s.sideLabel}</Text>…
        </Text>
      </View>
    );
  }
  const clamped = info.stakeCents < s.proposedStakeCents;
  return (
    <View style={[styles.acceptedBanner, { backgroundColor: withAlpha(color, "2e"), borderColor: withAlpha(color, "8c") }]}>
      <Text style={styles.acceptedText}>
        <Text style={{ color }}>✓  </Text>
        {info.already ? "Already in your book — " : "You're in — "}
        <Text style={{ color, fontFamily: "monospace", fontWeight: "700" }}>{usd(info.stakeCents)}</Text>
        {" on "}
        <Text style={{ color, fontWeight: "800" }}>{s.sideLabel}</Text>
      </Text>
      {clamped && (
        <Text style={styles.acceptedClamped}>Held to your free Cash — suggested {usd(s.proposedStakeCents)}.</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 22, overflow: "hidden", backgroundColor: colors.panel2,
    borderWidth: 1, borderColor: colors.line, padding: 15,
  },
  topRow: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  kindBadge: { paddingVertical: 4, paddingHorizontal: 9, borderRadius: 18, borderWidth: 1 },
  kindBadgeText: { fontSize: 9, letterSpacing: 1.2, textTransform: "uppercase", fontWeight: "800" },
  badge: {
    flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "rgba(0,0,0,0.4)",
    paddingVertical: 4, paddingHorizontal: 9, borderRadius: 18,
  },
  timerBadge: { marginLeft: "auto" },
  badgeUrgent: { borderWidth: 1, borderColor: "rgba(255,59,78,0.6)" },
  badgeDot: { width: 6, height: 6, borderRadius: 3 },
  badgeText: { color: "#fff", fontSize: 9, letterSpacing: 1.2, textTransform: "uppercase", fontWeight: "700" },
  timer: { fontFamily: "monospace", fontSize: 12, letterSpacing: 0 },
  timerUrgent: { fontFamily: "monospace", fontSize: 12, letterSpacing: 0, color: colors.no },
  middle: { paddingVertical: 10 },
  question: { color: "#fff", fontSize: 20, lineHeight: 24, fontWeight: "800", letterSpacing: 0.2 },
  context: { marginTop: 6, fontSize: 12, color: "rgba(255,255,255,0.75)", lineHeight: 17 },
  contextStrong: { fontWeight: "700", color: "#fff" },
  narrative: { marginTop: 3, fontSize: 11, color: "rgba(255,255,255,0.6)" },
  oddsRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 5, gap: 8 },
  oddsSide: { fontFamily: "monospace", fontWeight: "700", fontSize: 12, flexShrink: 1 },
  oddsBar: { flexDirection: "row", height: 10, borderRadius: 6, overflow: "hidden", backgroundColor: "rgba(0,0,0,0.4)" },
  actions: { flexDirection: "row", alignItems: "stretch", gap: 8, marginTop: 10 },
  dismissBtn: {
    paddingVertical: 9, paddingHorizontal: 14, borderRadius: 14, justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.35)", borderWidth: 1.5, borderColor: colors.line,
  },
  dismissText: { color: colors.muted, fontSize: 12, fontWeight: "700" },
  acceptBtn: {
    flex: 1, minWidth: 0, paddingVertical: 9, paddingHorizontal: 8, borderRadius: 14,
    borderWidth: 1.5, alignItems: "center", gap: 1,
  },
  acceptTitle: { fontSize: 16, fontWeight: "800", lineHeight: 20 },
  acceptSub: { fontSize: 10, color: "rgba(255,255,255,0.7)" },
  acceptedBanner: { marginTop: 10, padding: 12, borderRadius: 16, borderWidth: 1.5 },
  acceptedText: { textAlign: "center", fontSize: 13, color: "#fff" },
  acceptedClamped: { textAlign: "center", fontSize: 10, color: "rgba(255,255,255,0.65)", marginTop: 4 },
  footnote: { textAlign: "center", marginTop: 8, fontSize: 10, color: "rgba(255,255,255,0.5)", letterSpacing: 0.2 },
});
