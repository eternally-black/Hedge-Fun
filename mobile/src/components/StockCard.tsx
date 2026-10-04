// StockCard (native) — the tokenized-stock card: face, preview and the swipeable top card. Native twin of
// src/app/StockCard.tsx; the gesture physics are SwipeShell's, shared with DeckCard (the two decks must feel identical,
// as on the web, where StockDeckCard reuses SwipeShell).
import { memo, useEffect, useRef, useState } from "react";
import { Image, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { StackRole } from "../useSwipeCard";
import { SwipeShell } from "./SwipeShell";
import type { StockDeckCard as StockDeckCardT } from "@contract/api-types";
import { usd } from "../format";
import { colors, withAlpha } from "../theme";
import { STOCK_STAKE_PRESETS_CENTS } from "../../lib/config";
import { clampStakeCents } from "../useStockStake";
import type { SwipeDir } from "./DeckCard";

// The stock deck's accent. Deliberately NOT one of the category colors: a stock card is a different
// species from a prediction card (it never resolves, it has no two sides), and it must not read as
// one of the market categories it sits beside.
export const STOCK_ACCENT = "#34d399";


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
// StockDeckCard — one card of the stock deck stack (top, next, or premounted-hidden). SwipeShell is
// the prediction deck's shell verbatim, so the physics, the rise and the stamps read identically, as
// the web's StockDeckCard reuses its SwipeShell.
// ============================================================================
export function StockDeckCard({
  card,
  role,
  busy,
  onAction,
  stakeCents,
  onPickStake,
  realMode,
}: {
  card: StockDeckCardT;
  role: StackRole;
  busy: boolean;
  onAction: (dir: SwipeDir) => void;
  stakeCents: number;
  onPickStake: (c: number) => void;
  realMode: boolean;
}) {
  const top = role === "top";
  // A REAL buy keeps the card until /confirm books the lot, and a cancelled or failed one keeps it for
  // good — the shell springs a card that is still mounted after its fling back into place (web too).
  return (
    <SwipeShell
      role={role}
      enabled={!busy}
      onCommit={onAction}
      stampLabels={STAMPS}
      background={<View style={styles.faceBg} />}
    >
      <StockCardFace card={card} stakeCents={stakeCents} onPickStake={top ? onPickStake : NOOP} realMode={realMode} disabled={top && busy} />
    </SwipeShell>
  );
}

const STAMPS = { yes: "BUY", no: "PASS" };

const styles = StyleSheet.create({
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
});
