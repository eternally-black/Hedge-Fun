// StockCard (native) — the tokenized-stock card: face, preview and the swipeable top card. Native twin of
// src/app/StockCard.tsx; the gesture physics are DeckCard.tsx's, verbatim (the two decks must feel identical,
// and DeckCard's stamps are bound to a prediction card's two sides — hence a copy, not a shared wrapper).
import { memo, useEffect, useRef, useState } from "react";
import { Animated, Image, PanResponder, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { StockDeckCard as StockDeckCardT } from "@contract/api-types";
import { usd } from "../format";
import { colors, withAlpha } from "../theme";
import { STOCK_STAKE_PRESETS_CENTS } from "../../lib/config";
import { clampStakeCents } from "../useStockStake";
import { COMMIT_PX, type SwipeDir } from "./DeckCard";

// The stock deck's accent. Deliberately NOT one of the category colors: a stock card is a different
// species from a prediction card (it never resolves, it has no two sides), and it must not read as
// one of the market categories it sits beside.
export const STOCK_ACCENT = "#34d399";

const FLY_MS = 380; // outgoing card animates off-screen for this long
const MOVE_EPS = 5; // px of travel before a press counts as a drag

// A stable no-op for the preview card: an inline `() => {}` is a new value every render, which is
// exactly what memo() compares — the preview would re-render with the deck behind it for nothing.
const NOOP = () => {};

// ============================================================================
// StockCardFace — the full card VISUALS, pure + memoized. Same layering discipline as CardFace:
// background → content. No gesture, no clock of its own. Directional overlays and stamps are the
// wrapper's job here.
// ============================================================================
type FaceProps = {
  card: StockDeckCardT;
  stakeCents: number;
  onPickStake: (c: number) => void;
  // Which economy a swipe-right spends — the app's ONE Paper/Real switch, read from me.real.mode.
  // The card never buys on its own; this only states what the next swipe costs, where the amount is.
  realMode: boolean;
  disabled?: boolean;
};

export const StockCardFace = memo(function StockCardFace({ card, stakeCents, onPickStake, realMode, disabled = false }: FaceProps) {
  const change = card.change24hBp;
  const changeText = change == null ? "—" : `${change >= 0 ? "+" : "−"}${(Math.abs(change) / 100).toFixed(2)}%`;
  const changeColor = change == null ? colors.muted : change >= 0 ? colors.yes : colors.no;
  // What a swipe-right on THIS card actually spends. An asset with no Solana pool has no on-chain
  // market to buy in, so it stays paper even in real mode — and the chips must say so, or the card
  // states one economy while the swipe spends the other.
  const spendsReal = realMode && card.tradable;

  return (
    <View style={styles.faceRoot}>
      <View style={styles.faceBg} pointerEvents="none" />

      <View style={styles.content}>
        <View style={styles.topRow}>
          <View style={styles.badge}>
            <StockLogo card={card} />
            <Text style={styles.badgeSymbol}>{card.symbol}</Text>
          </View>
          <View style={styles.badge}>
            <View style={[styles.dot, { backgroundColor: card.openNow ? colors.yes : colors.muted }]} />
            <Text style={styles.badgeText}>
              {card.tradingHours === "TwentyFourFive" ? "24/5" : "Mkt hours"}
            </Text>
          </View>
          {/* The money tag, in the one slot that has always told the truth about this card's economy:
              no on-chain market → paper whatever the mode; real mode on a tradable asset → gold. */}
          {!card.tradable ? (
            <View style={styles.badge}>
              <Text style={[styles.badgeText, { color: colors.muted }]}>Paper only</Text>
            </View>
          ) : realMode ? (
            <View style={[styles.badge, styles.badgeReal]}>
              <Text style={[styles.badgeText, { color: colors.gold }]}>Real</Text>
            </View>
          ) : null}
        </View>

        <View style={styles.middle}>
          <Text style={styles.name} numberOfLines={2}>{card.name}</Text>
          {/* the one-line "what this is" — only when the server has one; no placeholder line. */}
          {card.blurb ? <Text style={styles.blurb} numberOfLines={2}>{card.blurb}</Text> : null}
          <Text style={styles.underlying}>{card.underlying}</Text>
          <View style={styles.priceRow}>
            <Text style={styles.price}>{usd(card.priceCents)}</Text>
            <View style={styles.changeRow}>
              <Text style={[styles.change, { color: changeColor }]}>{changeText}</Text>
              <Text style={styles.changeLabel}>24h</Text>
            </View>
          </View>
        </View>

        <StakeChips stakeCents={stakeCents} onPickStake={onPickStake} real={spendsReal} disabled={disabled} />

        <Text style={styles.cta}>Swipe right to buy · left to pass</Text>
      </View>
    </View>
  );
});

// The amount row: three preset sizes plus one the user types. Its own component because the custom
// chip carries state (open, draft, refused) and StockCardFace is memo()'d — a keystroke must not
// re-render the card behind it.
function StakeChips({ stakeCents, onPickStake, real, disabled }: { stakeCents: number; onPickStake: (c: number) => void; real: boolean; disabled: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // A refused amount flashes. Without it a fat-fingered "600" just closes the input and leaves the
  // old stake standing, which reads as a tap the card ignored.
  const [refused, setRefused] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(flashTimer.current), []);

  // Any stake that is not a preset belongs to the custom chip — that is what puts a remembered $37
  // back on the card instead of leaving all four chips looking unselected.
  const custom = !(STOCK_STAKE_PRESETS_CENTS as readonly number[]).includes(stakeCents);

  const commit = () => {
    setEditing(false);
    const cents = clampStakeCents(draft);
    if (cents !== null) {
      onPickStake(cents);
      return;
    }
    if (draft.trim() === "") return; // opened the input and thought better of it — not a refusal
    setRefused(true);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setRefused(false), 700);
  };

  return (
    <View style={styles.chipsRow}>
      {STOCK_STAKE_PRESETS_CENTS.map((c) => {
        const active = c === stakeCents;
        return (
          <Pressable
            key={c}
            disabled={disabled}
            onPress={() => onPickStake(c)}
            style={[styles.chip, active && styles.chipActive, disabled && styles.chipDisabled]}
          >
            <Text style={styles.chipAmount}>{usd(c)}</Text>
            {/* the sublabel is the only place the amount says WHOSE money it is */}
            <Text style={[styles.chipSub, { color: real ? colors.gold : colors.muted }]}>{real ? "Real" : "Paper"}</Text>
          </Pressable>
        );
      })}

      {editing ? (
        // Twice the width of a preset while it is open: four chips across a 402px phone leaves ~65px
        // each, which is not enough of a field to type "12.50" into and read it back.
        <View style={[styles.chip, styles.chipActive, styles.chipEditing]}>
          <Text style={styles.chipDollar}>$</Text>
          <TextInput
            autoFocus
            keyboardType="decimal-pad"
            placeholder="5"
            placeholderTextColor={colors.muted}
            accessibilityLabel="Custom amount"
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={commit}
            onBlur={commit}
            style={styles.chipInput}
          />
        </View>
      ) : (
        <Pressable
          disabled={disabled}
          accessibilityLabel="Custom amount"
          onPress={() => { setDraft(""); setEditing(true); }}
          style={[styles.chip, custom && styles.chipActive, refused && styles.chipRefused, disabled && styles.chipDisabled]}
        >
          <Text style={[styles.chipAmount, refused && { color: colors.no }]}>{custom ? usd(stakeCents) : "$…"}</Text>
          <Text style={styles.chipSub}>Custom</Text>
        </Pressable>
      )}
    </View>
  );
}

// The logo, with a two-letter fallback. A broken image URL is a real case (the issuer's CDN is not
// ours), and a broken-image glyph on a card is worse than initials.
function StockLogo({ card }: { card: StockDeckCardT }) {
  const [broken, setBroken] = useState(false);
  if (!card.logoUrl || broken) {
    return (
      <View style={styles.logoFallback}>
        <Text style={styles.logoInitials}>{card.symbol.slice(0, 2).toUpperCase()}</Text>
      </View>
    );
  }
  return <Image source={{ uri: card.logoUrl }} style={styles.logo} onError={() => setBroken(true)} />;
}

// ============================================================================
// StockCardPreview — the next stock card sitting behind the top one. Same resting pose as
// CardPreview (scale / translateY, dimmed, pointerEvents none) so the rise animation hands off
// seamlessly when this card is promoted.
// ============================================================================
export const StockCardPreview = memo(function StockCardPreview({ card, stakeCents, realMode }: { card: StockDeckCardT; stakeCents: number; realMode: boolean }) {
  return (
    <View style={[styles.card, styles.preview]} pointerEvents="none">
      <StockCardFace card={card} stakeCents={stakeCents} onPickStake={NOOP} realMode={realMode} />
    </View>
  );
});

// ============================================================================
// StockDeckCard — the interactive top card. Same PanResponder + Animated physics as DeckCard.tsx,
// so the gesture reads identically across the two decks.
// ============================================================================
export function StockDeckCard({
  card,
  busy,
  onAction,
  stakeCents,
  onPickStake,
  realMode,
}: {
  card: StockDeckCardT;
  busy: boolean;
  onAction: (dir: SwipeDir) => void;
  stakeCents: number;
  onPickStake: (c: number) => void;
  realMode: boolean;
}) {
  const pan = useRef(new Animated.ValueXY()).current;
  const enabledRef = useRef(!busy);
  useEffect(() => { enabledRef.current = !busy; }, [busy]);
  const committedRef = useRef(false);
  const onCommitRef = useRef(onAction);
  useEffect(() => { onCommitRef.current = onAction; }, [onAction]);

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => enabledRef.current && !committedRef.current,
      onMoveShouldSetPanResponder: (_e, g) =>
        enabledRef.current && !committedRef.current && (Math.abs(g.dx) > MOVE_EPS || Math.abs(g.dy) > MOVE_EPS),
      onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], { useNativeDriver: false }),
      onPanResponderTerminate: () => {
        Animated.spring(pan, { toValue: { x: 0, y: 0 }, useNativeDriver: false }).start();
      },
      onPanResponderRelease: (_e, g) => {
        const ax = Math.abs(g.dx), ay = Math.abs(g.dy);
        // Up-bias matches the web deck: a clearly-vertical upward drag is SKIP; else horizontal YES/NO.
        let dir: SwipeDir, progress: number;
        if (ay > ax * 1.15 && g.dy < 0) { dir = "SKIP"; progress = Math.min(1, ay / COMMIT_PX); }
        else { dir = g.dx > 0 ? "YES" : "NO"; progress = Math.min(1, ax / COMMIT_PX); }

        if (progress >= 1) {
          committedRef.current = true;
          const toValue = dir === "YES" ? { x: 520, y: -90 } : dir === "NO" ? { x: -520, y: -90 } : { x: 0, y: -760 };
          Animated.timing(pan, { toValue, duration: FLY_MS, useNativeDriver: false }).start();
          // Hand off mid-fling so the next card starts rising at the 50% point (overlap).
          setTimeout(() => onCommitRef.current(dir), Math.round(FLY_MS / 2));
        } else {
          Animated.spring(pan, { toValue: { x: 0, y: 0 }, useNativeDriver: false, bounciness: 14 }).start();
        }
      },
    }),
  ).current;

  const rotate = pan.x.interpolate({ inputRange: [-160, 160], outputRange: ["-9deg", "9deg"], extrapolate: "clamp" });
  const yesOpacity = pan.x.interpolate({ inputRange: [0, COMMIT_PX], outputRange: [0, 1], extrapolate: "clamp" });
  const noOpacity = pan.x.interpolate({ inputRange: [-COMMIT_PX, 0], outputRange: [1, 0], extrapolate: "clamp" });
  const skipOpacity = pan.y.interpolate({ inputRange: [-COMMIT_PX, 0], outputRange: [1, 0], extrapolate: "clamp" });

  return (
    <Animated.View
      style={[styles.card, { transform: [...pan.getTranslateTransform(), { rotate }] }]}
      {...responder.panHandlers}
    >
      <StockCardFace card={card} stakeCents={stakeCents} onPickStake={onPickStake} realMode={realMode} disabled={busy} />
      {/* direction stamps, driven by drag progress */}
      <Animated.View style={[styles.stamp, styles.stampLeft, { opacity: noOpacity, borderColor: colors.no }]} pointerEvents="none">
        <Text style={[styles.stampText, { color: colors.no }]}>PASS</Text>
      </Animated.View>
      <Animated.View style={[styles.stamp, styles.stampRight, { opacity: yesOpacity, borderColor: colors.yes }]} pointerEvents="none">
        <Text style={[styles.stampText, { color: colors.yes }]}>BUY</Text>
      </Animated.View>
      <Animated.View style={[styles.stamp, styles.stampTop, { opacity: skipOpacity, borderColor: colors.skip }]} pointerEvents="none">
        <Text style={[styles.stampText, { color: colors.skip }]}>SKIP</Text>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
    borderRadius: 26, overflow: "hidden",
    backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.line,
  },
  preview: { transform: [{ scale: 0.95 }, { translateY: -10 }], opacity: 0.9 },
  faceRoot: { flex: 1 },
  faceBg: {
    position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: withAlpha(STOCK_ACCENT, "2e"),
  },
  content: { flex: 1, paddingTop: 16, paddingHorizontal: 18, paddingBottom: 18 },
  topRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  badge: {
    flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "rgba(0,0,0,0.4)",
    paddingVertical: 6, paddingHorizontal: 11, borderRadius: 20,
  },
  badgeReal: { borderWidth: 1, borderColor: withAlpha(colors.gold, "73") },
  badgeSymbol: { fontSize: 11, letterSpacing: 0.9, fontWeight: "800", color: "#fff" },
  badgeText: { fontSize: 10, letterSpacing: 1, textTransform: "uppercase", fontWeight: "700", color: "#fff" },
  dot: { width: 7, height: 7, borderRadius: 4 },
  logo: { width: 22, height: 22, borderRadius: 11 },
  logoFallback: {
    width: 22, height: 22, borderRadius: 11, backgroundColor: withAlpha(STOCK_ACCENT, "66"),
    alignItems: "center", justifyContent: "center",
  },
  logoInitials: { fontSize: 9, fontWeight: "800", color: "#fff" },
  middle: { flex: 1, justifyContent: "center", paddingVertical: 14 },
  name: { fontSize: 30, lineHeight: 32, letterSpacing: 0.2, color: "#fff", fontWeight: "800" },
  blurb: { marginTop: 6, fontSize: 12, color: colors.muted, lineHeight: 16 },
  underlying: { marginTop: 6, fontSize: 12, color: "rgba(255,255,255,0.6)", letterSpacing: 0.2 },
  priceRow: { marginTop: 14, flexDirection: "row", alignItems: "flex-end", gap: 10 },
  price: { fontWeight: "700", fontSize: 40, lineHeight: 42, color: "#fff" },
  changeRow: { flexDirection: "row", alignItems: "flex-end", gap: 5 },
  change: { fontWeight: "700", fontSize: 14 },
  changeLabel: { fontSize: 10, color: colors.muted, letterSpacing: 0.8, textTransform: "uppercase" },
  chipsRow: { flexDirection: "row", gap: 8, marginBottom: 10 },
  chip: {
    flex: 1, alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.4)",
    borderWidth: 1, borderColor: colors.line,
    paddingVertical: 8, paddingHorizontal: 6, borderRadius: 14,
  },
  chipActive: { borderColor: colors.gold },
  chipRefused: { borderColor: colors.no },
  chipDisabled: { opacity: 0.5 },
  chipAmount: { fontWeight: "700", fontSize: 15, color: "#fff" },
  chipSub: { fontSize: 8, letterSpacing: 1, textTransform: "uppercase" },
  chipEditing: { flex: 2, flexDirection: "row", alignItems: "center", gap: 3 },
  chipDollar: { fontWeight: "700", fontSize: 15, color: colors.muted },
  chipInput: { flex: 1, minWidth: 0, margin: 0, padding: 0, fontWeight: "700", fontSize: 15, color: "#fff" },
  cta: { textAlign: "center", marginTop: 12, fontSize: 11, color: "rgba(255,255,255,0.55)", letterSpacing: 0.2 },
  stamp: {
    position: "absolute", paddingVertical: 6, paddingHorizontal: 14, borderRadius: 12,
    borderWidth: 3, backgroundColor: "rgba(10,10,15,0.75)", maxWidth: "80%",
  },
  stampLeft: { top: 42, left: 18, transform: [{ rotate: "-14deg" }] },
  stampRight: { top: 42, right: 18, transform: [{ rotate: "14deg" }] },
  stampTop: { top: 20, alignSelf: "center" },
  stampText: { fontSize: 22, fontWeight: "900", letterSpacing: 1 },
});
