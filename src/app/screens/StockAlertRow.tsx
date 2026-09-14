"use client";

import type { StockAlertRow as StockAlertRowData } from "@/lib/api-types";
import { usd } from "../ui";

// One row of the "In profit" section of the results inbox: an OPEN tokenized-stock lot that crossed
// a profit tier. Not a settled result — nothing is booked and the reveal never plays it, it is a
// nudge. Same panel language as PredictionRow (radius, border, padding, fonts) so the two lists read
// as one inbox.
export function StockAlertRow({ row, onOpen }: { row: StockAlertRowData; onOpen?: () => void }) {
  const up = row.pnlCents >= 0;
  const pnlColor = up ? "var(--yes)" : "var(--no)";
  const pct = (bp: number) => `${bp / 100}%`;
  const subtitle =
    row.pnlBp >= row.tierBp
      ? `Up +${pct(row.pnlBp)} since you bought · take profit?`
      : `Was up +${pct(row.tierBp)} · now ${row.pnlBp >= 0 ? "+" : "−"}${pct(Math.abs(row.pnlBp))}`;

  return (
    <div
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen}
      onKeyDown={onOpen ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } } : undefined}
      style={{ position: "relative", display: "flex", gap: 11, padding: "12px 13px", background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 14, cursor: onOpen ? "pointer" : "default" }}
    >
      {!row.seen ? (
        <span aria-hidden="true" style={{ position: "absolute", left: 4, top: "50%", transform: "translateY(-50%)", width: 6, height: 6, borderRadius: "50%", background: "var(--energy)" }} />
      ) : null}
      {row.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={row.logoUrl} alt="" width={36} height={36} style={{ width: 36, height: 36, borderRadius: "50%", objectFit: "cover", flexShrink: 0, background: "var(--panel2)" }} />
      ) : (
        <div style={{ width: 36, height: 36, borderRadius: "50%", background: "var(--panel2)", border: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--df)", fontSize: 12, color: "var(--muted)", flexShrink: 0 }}>
          {row.symbol.slice(0, 3)}
        </div>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 700, fontSize: 13 }}>{row.symbol}</span>
          <span style={{ fontSize: 11, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.name}</span>
          <span style={{ fontSize: 10, fontWeight: 700, color: row.mode === "REAL" ? "var(--gold)" : "var(--muted)", background: row.mode === "REAL" ? "color-mix(in srgb,var(--gold) 14%,var(--panel))" : "var(--panel2)", border: "1px solid " + (row.mode === "REAL" ? "color-mix(in srgb,var(--gold) 40%,var(--line))" : "var(--line)"), padding: "2px 7px", borderRadius: 20 }}>
            {row.mode === "REAL" ? "◎" : "PAPER"}
          </span>
        </div>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 3 }}>{subtitle}</div>
      </div>
      <div style={{ textAlign: "right", flexShrink: 0, alignSelf: "flex-start" }}>
        <div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 14, color: pnlColor, whiteSpace: "nowrap" }}>
          {up ? "+" : "−"}{usd(Math.abs(row.pnlCents))}
        </div>
        <div style={{ fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--gold)", fontWeight: 700, marginTop: 2 }}>
          +{pct(row.tierBp)} hit
        </div>
      </div>
    </div>
  );
}
