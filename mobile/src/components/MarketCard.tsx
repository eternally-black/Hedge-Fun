// MarketCard (native) — port of src/app/screens/MarketCard.tsx. The tappable near-50% binary card of
// the post-cap feed: the rounded panel (category background + question + odds + tap-to-bet). The
// caller sizes the box. Betting goes through useMarketBet below — the points-FREE flow: the same paper
// stake and cash hold as a swipe, but no points and no daily cap.
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { BetSide, DeckCard } from "@contract/api-types";
import { colors, withAlpha } from "../theme";
import { isFootballCard, SkinBackground } from "../skins";
import { catOf, cents, countdown, displayQuestion, isUpDown, marketHint, sideLabels, usd, winPayout } from "../format";
import { DECK_MIN_LEAD_MS } from "../../lib/config";
import type { Api } from "../api";

// Memoized on primitive-ish props so a /api/me refresh or a bet on a sibling never re-renders it.
export const MarketCard = memo(function MarketCard({ card, placedSide, nowMs, stakeCents, onBet }: {
  card: DeckCard;
  placedSide: BetSide | undefined;
  nowMs: number; // shared clock (ticks ~15s) — keeps Date.now() out of render
  stakeCents: number; // the paper stake the server charges (me.stakeCents)
  onBet: (card: DeckCard, side: BetSide) => void;
}) {
  const cat = catOf(card);
  const labels = sideLabels(card);
  const hint = marketHint(card);
  const cd = countdown(card.resolutionDeadline, nowMs);
  const expired = new Date(card.resolutionDeadline).getTime() - nowMs <= DECK_MIN_LEAD_MS;

  return (
    <View style={styles.card}>
      <SkinBackground skinId="classic" categoryColor={cat.color} isFootball={isFootballCard(card)} />
      <View style={styles.face}>
        <View style={styles.topRow}>
          <View style={styles.badge}>
            <View style={[styles.badgeDot, { backgroundColor: cat.color }]} />
            <Text style={styles.badgeText}>{cat.label}</Text>
          </View>
          <View style={[styles.badge, cd.urgent && styles.badgeUrgent]}>
            <Text style={styles.badgeText}>⏱ <Text style={cd.urgent ? styles.timerUrgent : styles.timer}>{cd.text}</Text></Text>
          </View>
        </View>

        <View style={styles.middle}>
          <Text style={styles.question} numberOfLines={3}>{displayQuestion(card)}</Text>
          {isUpDown(card)
            ? <Text style={styles.hint}>{cd.relText}</Text>
            : hint ? <Text style={styles.hint} numberOfLines={2}>{hint}</Text> : null}
        </View>

        <View style={styles.oddsBlock}>
          <View style={styles.oddsRow}>
            <Text style={[styles.oddsSide, { color: colors.no }]} numberOfLines={1}>{labels.no} {cents(card.noPriceBp)}</Text>
            <Text style={[styles.oddsSide, { color: colors.yes }]} numberOfLines={1}>{cents(card.yesPriceBp)} {labels.yes}</Text>
          </View>
          <View style={styles.oddsBar}>
            <View style={{ width: `${card.noPriceBp / 100}%`, backgroundColor: colors.no, height: "100%" }} />
            <View style={{ flex: 1, backgroundColor: colors.yes, height: "100%" }} />
          </View>
        </View>

        {/* Two tap-to-bet buttons, or a locked banner once placed. */}
        {placedSide ? (
          <LockedBanner card={card} side={placedSide} labels={labels} stakeCents={stakeCents} />
        ) : (
          <View style={styles.btnRow}>
            <BetButton label={labels.no} payout={usd(winPayout(card.noPriceBp, stakeCents))} color={colors.no} disabled={expired} onPress={() => onBet(card, "NO")} />
            <BetButton label={labels.yes} payout={usd(winPayout(card.yesPriceBp, stakeCents))} color={colors.yes} disabled={expired} onPress={() => onBet(card, "YES")} />
          </View>
        )}
        <Text style={styles.footnote}>{expired ? "Resolving — closed for new calls" : `${usd(stakeCents)} · no points, shards on wins`}</Text>
      </View>
    </View>
  );
});

function BetButton({ label, payout, color, disabled, onPress }: { label: string; payout: string; color: string; disabled?: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={[styles.betBtn, { backgroundColor: withAlpha(color, "29"), borderColor: withAlpha(color, "80") }, disabled && { opacity: 0.5 }]}
    >
      <Text style={[styles.betLabel, { color }]} numberOfLines={1}>{label}</Text>
      <Text style={styles.betSub}>to win <Text style={[styles.betPayout, { color }]}>{payout}</Text></Text>
    </TouchableOpacity>
  );
}

function LockedBanner({ card, side, labels, stakeCents }: { card: DeckCard; side: BetSide; labels: { yes: string; no: string }; stakeCents: number }) {
  const color = side === "YES" ? colors.yes : colors.no;
  const label = side === "YES" ? labels.yes : labels.no;
  const payout = usd(winPayout(side === "YES" ? card.yesPriceBp : card.noPriceBp, stakeCents));
  return (
    <View style={[styles.locked, { backgroundColor: withAlpha(color, "2e"), borderColor: withAlpha(color, "8c") }]}>
      <Text style={[styles.lockedCheck, { color }]}>✓</Text>
      <Text style={styles.lockedText}>
        You&apos;re in on <Text style={[styles.lockedLabel, { color }]}>{label}</Text> — <Text style={[styles.lockedPayout, { color }]}>{payout}</Text> to win
      </Text>
    </View>
  );
}

// The points-FREE bet flow behind the feed. Optimistic (lock the card, then POST /api/feed/bet), with
// the deck's cash gate + 402/409 handling. Reads me/placed via refs so placeBet stays stable.
export function useMarketBet({ api, me, onRefreshMe, onToast, onTopup }: {
  api: Api;
  me: { cashCents: number; stakeCents: number } | null;
  onRefreshMe: () => void;
  onToast: (msg: string) => void;
  onTopup: () => void;
}): { placed: Map<string, BetSide>; placeBet: (card: DeckCard, side: BetSide) => void } {
  const [placed, setPlaced] = useState<Map<string, BetSide>>(new Map());
  const meRef = useRef(me);
  useEffect(() => { meRef.current = me; }, [me]);
  const placedRef = useRef(placed);
  useEffect(() => { placedRef.current = placed; }, [placed]);

  const placeBet = useCallback((card: DeckCard, side: BetSide) => {
    if (placedRef.current.has(card.id)) return; // already bet this card
    const m = meRef.current;
    if (m && m.cashCents < m.stakeCents) {
      onToast("No free cash — top up to keep going");
      onTopup();
      return;
    }
    setPlaced((prev) => new Map(prev).set(card.id, side));
    api("/api/feed/bet", { method: "POST", body: JSON.stringify({ marketId: card.id, side }) })
      .then(() => onRefreshMe())
      .catch((e) => {
        const status = (e as { status?: number }).status;
        if (status === 409) { void onRefreshMe(); return; } // already bet / expired — leave it locked
        setPlaced((prev) => { const n = new Map(prev); n.delete(card.id); return n; }); // roll back so retry/top-up is possible
        if (status === 402) { onToast("No free cash — top up to keep going"); onTopup(); }
        else console.error(e);
      });
  }, [api, onRefreshMe, onToast, onTopup]);

  return { placed, placeBet };
}

const styles = StyleSheet.create({
  card: { flex: 1, borderRadius: 22, overflow: "hidden", backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.line },
  face: { flex: 1, paddingVertical: 14, paddingHorizontal: 15 },
  topRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  badge: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "rgba(0,0,0,0.4)", paddingVertical: 4, paddingHorizontal: 9, borderRadius: 18 },
  badgeUrgent: { borderWidth: 1, borderColor: "rgba(255,59,78,0.6)" },
  badgeDot: { width: 6, height: 6, borderRadius: 3 },
  badgeText: { color: "#fff", fontSize: 9, letterSpacing: 1.2, textTransform: "uppercase", fontWeight: "700" },
  timer: { fontFamily: "monospace", fontSize: 12, letterSpacing: 0 },
  timerUrgent: { fontFamily: "monospace", fontSize: 12, letterSpacing: 0, color: colors.no },
  middle: { flex: 1, justifyContent: "center", paddingVertical: 8, minHeight: 0 },
  question: { color: "#fff", fontSize: 20, lineHeight: 24, fontWeight: "800", letterSpacing: 0.2 },
  hint: { marginTop: 6, fontSize: 11, color: "rgba(255,255,255,0.6)", lineHeight: 15 },
  oddsBlock: { marginBottom: 10 },
  oddsRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 5, gap: 8 },
  oddsSide: { fontFamily: "monospace", fontWeight: "700", fontSize: 12, flexShrink: 1 },
  oddsBar: { flexDirection: "row", height: 10, borderRadius: 6, overflow: "hidden", backgroundColor: "rgba(0,0,0,0.4)" },
  btnRow: { flexDirection: "row", alignItems: "stretch", gap: 8 },
  betBtn: { flex: 1, minWidth: 0, paddingVertical: 9, paddingHorizontal: 8, borderRadius: 14, borderWidth: 1.5, alignItems: "center", gap: 1 },
  betLabel: { fontSize: 16, lineHeight: 20, fontWeight: "800", maxWidth: "100%" },
  betSub: { fontSize: 10, color: "rgba(255,255,255,0.7)" },
  betPayout: { fontFamily: "monospace", fontWeight: "700" },
  locked: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, paddingVertical: 13, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1.5 },
  lockedCheck: { fontSize: 16 },
  lockedText: { fontSize: 13, color: "#fff", flexShrink: 1 },
  lockedLabel: { fontWeight: "800" },
  lockedPayout: { fontFamily: "monospace", fontWeight: "700" },
  footnote: { textAlign: "center", marginTop: 8, fontSize: 10, color: "rgba(255,255,255,0.5)", letterSpacing: 0.2 },
});
