// PredictionRow (native) — port of src/app/screens/PredictionRow.tsx. ONE row for every list of the
// user's own calls: a question that wraps, a calm subtitle, the side pill (what the user actually
// picked), tap to expand the details, and — for a sellable REAL position — a two-tap Close that
// names the money.
import { memo, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { ExitQuoteRow } from "@contract/api-types";
import { cents, countdown, deltaStr, resultMeta, usd } from "../format";
import { colors } from "../theme";

export type PredictionRowData = {
  id: string;
  question: string;
  side: "YES" | "NO";
  sideLabel: string; // the real name of the side the user took ("Under 2.5", "Up", "Yes")
  status: "PENDING" | "WIN" | "LOSS" | "PUSH";
  league?: string | null; // "Soccer", "CS2" — leads the subtitle when known
  category?: string | null; // fallback when the market names no discipline
  hedge?: boolean; // an accepted hedge leg — the subtitle says so
  stakeCents: number;
  lockedPriceBp: number; // entry price
  pnlCents: number | null; // null while open
  createdAt: string;
  resolutionDeadline?: string | null; // absent on a settled inbox row
  startsAt?: string | null; // kick-off; equal to the deadline on a match
  settledAt?: string | null;
  outcome?: string | null; // "Resolved Up" — the settled row's human verdict
  shards?: number;
  closable?: boolean; // REAL position with a sellable remainder
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const PredictionRow = memo(function PredictionRow({
  row,
  nowMs,
  exitQuote,
  onClosePosition,
  closing,
}: {
  row: PredictionRowData;
  nowMs: number;
  // Live mark-to-market for an open REAL position (useExitQuotes).
  exitQuote?: ExitQuoteRow;
  // Present only where a position can actually be sold. Absent = a display-only list.
  onClosePosition?: (row: PredictionRowData) => void | Promise<void>;
  closing?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Two taps, not one: this button sells a position at market. The arm resets itself so a
  // half-pressed row does not sit primed under someone's thumb.
  const [armed, setArmed] = useState(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(armTimer.current), []);

  const sideColor = row.side === "YES" ? colors.yes : colors.no;
  const settled = row.status !== "PENDING";
  // Live numbers belong to an open position that can still be sold — a settled row's money is done.
  const live = !settled && row.closable ? exitQuote : undefined;
  const deadlinePassed = !!row.resolutionDeadline && new Date(row.resolutionDeadline).getTime() <= nowMs;
  // For a match the "deadline" IS the kick-off (Gamma's endDate equals gameStartTime), so once that
  // clock runs out the game is ON, not overdue.
  const kickoffClock =
    !!row.startsAt &&
    !!row.resolutionDeadline &&
    Math.abs(new Date(row.startsAt).getTime() - new Date(row.resolutionDeadline).getTime()) < 60_000;

  // Right column only when there IS money to state: settled pays, or a live quote says what the
  // position would fetch. A row that is merely waiting states the wait in its subtitle instead.
  let headline: string | null = null, sub: string | null = null, accent: string = colors.muted;
  if (settled) {
    const status = row.status as "WIN" | "LOSS" | "PUSH";
    const m = resultMeta(status);
    headline = deltaStr(status, row.pnlCents ?? 0);
    sub = m.tag;
    accent = m.accent;
  } else if (live) {
    headline = `≈ ${usd(live.proceedsCents)}`;
    sub = `${live.pnlCents > 0 ? "+" : ""}${usd(live.pnlCents)}`; // usd() prints its own minus
    accent = live.pnlCents >= 0 ? colors.yes : colors.no;
  }

  // Subtitle: the discipline first (a row must say WHICH sport), then either what the position costs
  // and is worth now, or what the call was and how it landed.
  const discipline = row.league ?? (row.category && row.category !== "other" ? cap(row.category) : null);
  const lead = row.hedge ? (discipline ? `🛡 Hedge · ${discipline}` : "🛡 Hedge") : discipline;
  const detail = settled
    ? `Your call ${row.sideLabel}${row.outcome ? ` · ${row.outcome}` : ""}`
    : `${cents(row.lockedPriceBp)} · ${usd(row.stakeCents)} stake${live ? ` · now ${cents(live.priceBp)}` : ""}${
        !row.resolutionDeadline
          ? ""
          : deadlinePassed
            ? kickoffClock ? " · in play" : " · ⏳ awaiting result"
            : ` · ⏱ ${kickoffClock ? "starts in " : ""}${countdown(row.resolutionDeadline, nowMs).text}`
      }`;

  const when = (iso: string) =>
    new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  const pressClose = () => {
    if (closing || !onClosePosition) return;
    if (!armed) {
      setArmed(true);
      armTimer.current = setTimeout(() => setArmed(false), 4000);
      return;
    }
    clearTimeout(armTimer.current);
    setArmed(false);
    void onClosePosition(row);
  };

  return (
    <View style={styles.card}>
      <TouchableOpacity
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((o) => !o)}
        style={styles.header}
      >
        <View style={[styles.pill, { backgroundColor: `${sideColor}2e` }]}>
          <Text style={[styles.pillText, { color: sideColor }]} numberOfLines={2}>
            {row.sideLabel.length > 11 ? `${row.sideLabel.slice(0, 10)}…` : row.sideLabel}
          </Text>
        </View>
        <View style={styles.mid}>
          {/* The question wraps — and open, it stops being clipped at all. */}
          <Text style={styles.question} numberOfLines={open ? undefined : 2}>{row.question}</Text>
          <Text style={styles.subtitle}>{lead ? `${lead} · ` : ""}{detail}</Text>
        </View>
        {headline ? (
          <View style={styles.right}>
            <Text style={[styles.headline, { color: accent }]} numberOfLines={1}>{headline}</Text>
            {sub ? <Text style={[styles.subTag, { color: accent }]}>{sub}</Text> : null}
            {row.shards ? <Text style={styles.shards}>+{row.shards} ◆</Text> : null}
          </View>
        ) : null}
        <Text style={[styles.chevron, open && styles.chevronOpen]}>▾</Text>
      </TouchableOpacity>

      {/* Selling out gets its own line: crammed into the header it took the width the question
          needed. Outside the header, the press cannot toggle the row either. */}
      {onClosePosition && row.closable ? (
        <View style={styles.closeRow}>
          <TouchableOpacity
            activeOpacity={0.8}
            disabled={closing}
            onPress={pressClose}
            style={[
              styles.closeBtn,
              { backgroundColor: armed ? colors.gold : "transparent", borderColor: armed ? colors.gold : colors.line },
              closing && { opacity: 0.5 },
            ]}
          >
            {/* The confirm names the money: what comes back and whether that is a gain or a loss. */}
            <Text style={[styles.closeText, { color: armed ? "#1a1205" : colors.muted }]}>
              {closing
                ? "Selling…"
                : armed
                  ? live
                    ? `Sell ${usd(live.proceedsCents)} (${live.pnlCents > 0 ? "+" : ""}${usd(live.pnlCents)})?`
                    : "Sell now?"
                  : "Close"}
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {open ? (
        <View style={styles.detail}>
          {lead ? <Detail k="Market" v={lead} /> : null}
          <Detail k="Pick" v={row.sideLabel} color={sideColor} />
          <Detail k="Entry" v={`${cents(row.lockedPriceBp)} · ${usd(row.stakeCents)} stake`} />
          {live ? <Detail k="Market now" v={`${cents(live.priceBp)} per share`} /> : null}
          {live ? (
            <Detail
              k="Sell now for"
              v={`${usd(live.proceedsCents)} · ${live.pnlCents > 0 ? "+" : ""}${usd(live.pnlCents)}${live.partial ? " (book is thin)" : ""}`}
              color={live.pnlCents >= 0 ? colors.yes : colors.no}
            />
          ) : null}
          <Detail k="Placed" v={when(row.createdAt)} />
          {row.resolutionDeadline ? (
            <Detail k={kickoffClock ? "Kick-off" : settled ? "Resolved" : "Resolves"} v={when(row.resolutionDeadline)} />
          ) : null}
          {row.settledAt ? <Detail k="Settled" v={when(row.settledAt)} /> : null}
          {row.outcome ? <Detail k="Outcome" v={row.outcome} /> : null}
          {settled && headline ? <Detail k="Result" v={`${sub ?? ""} · ${headline}`.trim()} color={accent} /> : null}
        </View>
      ) : null}
    </View>
  );
});

// One label/value line of the expanded detail; the fixed key width lines every value up.
function Detail({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <View style={styles.detailLine}>
      <Text style={styles.detailKey}>{k}</Text>
      <Text style={[styles.detailVal, color ? { color } : null]}>{v}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: 14 },
  header: { flexDirection: "row", gap: 11, paddingVertical: 12, paddingHorizontal: 13 },
  pill: {
    minWidth: 36, height: 36, maxWidth: 84, paddingHorizontal: 7, borderRadius: 10, alignSelf: "flex-start",
    alignItems: "center", justifyContent: "center", flexShrink: 0, overflow: "hidden",
  },
  pillText: { fontSize: 12, lineHeight: 13, textAlign: "center", fontWeight: "700" },
  mid: { flex: 1, minWidth: 0 },
  question: { fontSize: 13, fontWeight: "600", lineHeight: 16, color: colors.text },
  subtitle: { fontSize: 11, color: colors.muted, marginTop: 3, lineHeight: 15 },
  right: { alignItems: "flex-end", flexShrink: 0, alignSelf: "flex-start" },
  headline: { fontFamily: "monospace", fontWeight: "700", fontSize: 14 },
  subTag: { fontSize: 10, letterSpacing: 0.6, textTransform: "uppercase", fontWeight: "700", marginTop: 2 },
  shards: { fontSize: 10, color: colors.gold, marginTop: 2 },
  chevron: { flexShrink: 0, alignSelf: "center", color: colors.muted, fontSize: 10 },
  chevronOpen: { transform: [{ rotate: "180deg" }] },
  closeRow: { flexDirection: "row", justifyContent: "flex-end", paddingHorizontal: 13, paddingBottom: 11 },
  closeBtn: { paddingVertical: 7, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1 },
  closeText: { fontWeight: "700", fontSize: 11 },
  detail: { borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 10, paddingHorizontal: 13, paddingBottom: 12, gap: 6 },
  detailLine: { flexDirection: "row", gap: 12 },
  detailKey: { color: colors.muted, fontSize: 11, lineHeight: 15, width: 96 },
  detailVal: { color: colors.text, fontSize: 11, lineHeight: 15, flex: 1, minWidth: 0 },
});
