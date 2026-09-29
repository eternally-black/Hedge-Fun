// StockAlertRow (native) — port of src/app/screens/StockAlertRow.tsx. One row of the "In profit"
// section of the results inbox: an OPEN tokenized-stock lot that crossed a profit tier. Not a settled
// result — nothing is booked and the reveal never plays it, it is a nudge. Same panel language as
// PredictionRow so the two lists read as one inbox.
import { useState } from "react";
import { Image, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { StockAlertRow as StockAlertRowData } from "@contract/api-types";
import { usd } from "../format";
import { colors, withAlpha } from "../theme";

export function StockAlertRow({ row, onOpen }: { row: StockAlertRowData; onOpen?: () => void }) {
  // The logo is remote and may 404 — fall back to the symbol initials on the error event.
  const [logoFailed, setLogoFailed] = useState(false);
  const up = row.pnlCents >= 0;
  const pnlColor = up ? colors.yes : colors.no;
  const pct = (bp: number) => `${bp / 100}%`;
  const subtitle =
    row.pnlBp >= row.tierBp
      ? `Up +${pct(row.pnlBp)} since you bought · take profit?`
      : `Was up +${pct(row.tierBp)} · now ${row.pnlBp >= 0 ? "+" : "−"}${pct(Math.abs(row.pnlBp))}`;

  const body = (
    <>
      {!row.seen ? <View style={styles.unreadDot} /> : null}
      {row.logoUrl && !logoFailed ? (
        <Image source={{ uri: row.logoUrl }} onError={() => setLogoFailed(true)} style={styles.logo} />
      ) : (
        <View style={styles.logoFallback}>
          <Text style={styles.logoFallbackText}>{row.symbol.slice(0, 3)}</Text>
        </View>
      )}
      <View style={styles.mid}>
        <View style={styles.titleRow}>
          <Text style={styles.symbol}>{row.symbol}</Text>
          <Text style={styles.name} numberOfLines={1}>{row.name}</Text>
          <View style={[styles.modeChip, row.mode === "REAL" ? styles.modeChipReal : styles.modeChipPaper]}>
            <Text style={[styles.modeChipText, { color: row.mode === "REAL" ? colors.gold : colors.muted }]}>
              {row.mode === "REAL" ? "◎" : "PAPER"}
            </Text>
          </View>
        </View>
        <Text style={styles.subtitle}>{subtitle}</Text>
      </View>
      <View style={styles.right}>
        <Text style={[styles.pnl, { color: pnlColor }]} numberOfLines={1}>
          {up ? "+" : "−"}{usd(Math.abs(row.pnlCents))}
        </Text>
        <Text style={styles.tier}>+{pct(row.tierBp)} hit</Text>
      </View>
    </>
  );

  // No onOpen = a display-only row.
  if (!onOpen) return <View style={styles.row}>{body}</View>;
  return (
    <TouchableOpacity activeOpacity={0.8} accessibilityRole="button" onPress={onOpen} style={styles.row}>
      {body}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: {
    position: "relative", flexDirection: "row", gap: 11, paddingVertical: 12, paddingHorizontal: 13,
    backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: 14,
  },
  unreadDot: { position: "absolute", left: 4, top: "50%", marginTop: -3, width: 6, height: 6, borderRadius: 3, backgroundColor: colors.energy },
  logo: { width: 36, height: 36, borderRadius: 18, flexShrink: 0, backgroundColor: colors.panel2 },
  logoFallback: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: colors.panel2, borderWidth: 1,
    borderColor: colors.line, alignItems: "center", justifyContent: "center", flexShrink: 0,
  },
  logoFallbackText: { fontSize: 12, color: colors.muted, fontWeight: "700" },
  mid: { flex: 1, minWidth: 0 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  symbol: { fontWeight: "700", fontSize: 13, color: colors.text },
  name: { fontSize: 11, color: colors.muted, flexShrink: 1 },
  modeChip: { paddingVertical: 2, paddingHorizontal: 7, borderRadius: 20, borderWidth: 1 },
  modeChipReal: { backgroundColor: withAlpha(colors.gold, "24"), borderColor: withAlpha(colors.gold, "66") },
  modeChipPaper: { backgroundColor: colors.panel2, borderColor: colors.line },
  modeChipText: { fontSize: 10, fontWeight: "700" },
  subtitle: { fontSize: 11, color: colors.muted, marginTop: 3 },
  right: { alignItems: "flex-end", flexShrink: 0, alignSelf: "flex-start" },
  pnl: { fontFamily: "monospace", fontWeight: "700", fontSize: 14 },
  tier: { fontSize: 10, letterSpacing: 0.6, textTransform: "uppercase", color: colors.gold, fontWeight: "700", marginTop: 2 },
});
