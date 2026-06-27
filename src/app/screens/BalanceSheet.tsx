"use client";

import { useCallback, useEffect, useState } from "react";
import { type Me, cents, usd, countdown } from "../ui";

type Api = (path: string, init?: RequestInit) => Promise<unknown>;

type Row = {
  id: string;
  question: string;
  sideLabel: string;
  side: "YES" | "NO";
  stakeCents: number;
  lockedPriceBp: number;
  status: "PENDING" | "WIN" | "LOSS" | "PUSH";
  pnlCents: number | null;
  resolutionDeadline: string;
  createdAt: string;
};

// Balance bottom-sheet (opened by tapping the Cash tile). Shows the Cash / Locked / Total split, a
// Top-Up button (free once, then 1 artifact), and the prediction history (same /api/history rows as
// the old HistorySheet). All money is derived from `me` during render — no mirrored server state.
export function BalanceSheet({ me, api, onClose, onTopupDone, onToast }: {
  me: Me | null;
  api: Api;
  onClose: () => void;
  onTopupDone: () => void | Promise<void>;
  onToast: (msg: string) => void;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [pending, setPending] = useState(0);
  const [nowMs, setNowMs] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setNowMs(Date.now());
    const t = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    api("/api/history")
      .then((d) => { const r = d as { rows: Row[]; pendingCount: number }; setRows(r.rows); setPending(r.pendingCount); })
      .catch(console.error);
  }, [api]);

  const doTopup = useCallback(async (kind: "free" | "artifact") => {
    if (busy) return;
    setBusy(true);
    try {
      await api("/api/topup", { method: "POST", body: JSON.stringify({ kind }) });
      await onTopupDone(); // parent refreshMe() → fresh cash/locked/topup
      onClose();
    } catch (e) {
      const status = (e as { status?: number }).status;
      // 409 = free already used / no longer eligible (raced the gate); 402 = no artifact.
      onToast(status === 402 ? "Need an artifact to top up" : "Top-up unavailable right now");
    } finally {
      setBusy(false);
    }
  }, [api, busy, onClose, onTopupDone, onToast]);

  return (
    <div onClick={onClose} style={{ position: "absolute", inset: 0, zIndex: 50, background: "rgba(4,4,8,.6)", backdropFilter: "blur(8px)", display: "flex", flexDirection: "column", justifyContent: "flex-end", animation: "hfRise .28s ease" }}>
      <div onClick={(e) => e.stopPropagation()} className="hf-scroll" style={{ background: "var(--bg2)", borderRadius: "28px 28px 0 0", borderTop: "1px solid var(--line)", padding: "8px 18px 22px", maxHeight: "82%", overflowY: "auto" }}>
        <div style={{ width: 42, height: 5, borderRadius: 4, background: "var(--line)", margin: "0 auto 14px" }} />

        {/* Cash / Locked / Total split panel */}
        <div style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 18, padding: "16px 18px", marginBottom: 14 }}>
          <div style={{ fontSize: 9, letterSpacing: ".14em", color: "var(--muted)", textTransform: "uppercase" }}>Cash</div>
          <div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 34, color: "var(--yes)", lineHeight: 1.05 }}>
            {me ? usd(Math.max(0, me.cashCents)) : "—"}
          </div>
          <div style={{ display: "flex", gap: 18, marginTop: 12 }}>
            <SplitStat label="In play" value={me ? usd(me.lockedCents) : "—"} />
            <SplitStat label="Total" value={me ? usd(me.balanceCents) : "—"} />
          </div>
          <TopupButton me={me} busy={busy} onTopup={doTopup} />
        </div>

        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 14 }}>
          <div style={{ fontFamily: "var(--df)", fontSize: 26 }}>Your predictions</div>
          {pending > 0 && <div style={{ fontSize: 11, color: "var(--skip)", fontWeight: 700 }}>{pending} open</div>}
        </div>

        {!rows ? (
          <div style={{ textAlign: "center", color: "var(--muted)", padding: 24 }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ textAlign: "center", color: "var(--muted)", padding: 24, fontSize: 13 }}>No predictions yet. Swipe a card to make your first call.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {rows.map((r) => (
              <HistoryRow key={r.id} row={r} nowMs={nowMs} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SplitStat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ lineHeight: 1.1 }}>
      <div style={{ fontSize: 8, letterSpacing: ".12em", color: "var(--muted)", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 15, color: "var(--text)", marginTop: 3 }}>{value}</div>
    </div>
  );
}

// One affordance, derived from me.topup. Always visible; disabled when neither path is open.
function TopupButton({ me, busy, onTopup }: { me: Me | null; busy: boolean; onTopup: (k: "free" | "artifact") => void }) {
  if (!me) return null;
  const t = me.topup;
  const grant = usd(t.grantCents);

  let label: string, kind: "free" | "artifact" | null, primary = false;
  if (t.freeTopupAvailable) { label = `Claim free ${grant}`; kind = "free"; primary = true; }
  else if (t.artifactTopupAvailable) { label = `Top up ${grant} · 1 ◆`; kind = "artifact"; primary = true; }
  else if (!t.freeTopupUsed) { label = "Free top-up unlocks when low on cash"; kind = null; }
  else { label = "Earn an artifact to top up"; kind = null; }

  const disabled = kind === null || busy;
  return (
    <button
      onClick={() => kind && onTopup(kind)}
      disabled={disabled}
      style={{
        width: "100%", marginTop: 14, padding: "12px 14px", borderRadius: 14, fontFamily: "var(--nf)",
        fontWeight: 700, fontSize: 14, cursor: disabled ? "default" : "pointer",
        border: `1px solid ${primary ? "color-mix(in srgb,var(--yes) 50%,transparent)" : "var(--line)"}`,
        background: primary ? "color-mix(in srgb,var(--yes) 16%,transparent)" : "var(--panel2)",
        color: primary ? "var(--yes)" : "var(--muted)", opacity: busy ? 0.6 : 1,
      }}
    >
      {busy ? "…" : label}
    </button>
  );
}

function HistoryRow({ row, nowMs }: { row: Row; nowMs: number }) {
  const sideColor = row.side === "YES" ? "var(--yes)" : "var(--no)";
  const sideBg = row.side === "YES" ? "color-mix(in srgb,var(--yes) 18%,transparent)" : "color-mix(in srgb,var(--no) 18%,transparent)";

  let statusText: string, statusColor: string, delta: string;
  if (row.status === "PENDING") {
    const deadlinePassed = new Date(row.resolutionDeadline).getTime() <= nowMs;
    if (deadlinePassed) {
      statusText = "AWAITING";
      statusColor = "var(--skip)";
      delta = "⏳ result soon";
    } else {
      statusText = "PENDING";
      statusColor = "var(--muted)";
      delta = "⏱ " + countdown(row.resolutionDeadline, nowMs).text;
    }
  } else if (row.status === "WIN") {
    statusText = "WON";
    statusColor = "var(--yes)";
    delta = `+${usd(row.pnlCents ?? 0)}`;
  } else if (row.status === "LOSS") {
    statusText = "LOST";
    statusColor = "var(--no)";
    delta = usd(row.pnlCents ?? 0); // already negative
  } else {
    statusText = "PUSH";
    statusColor = "var(--muted)";
    delta = "$0";
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 11, background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 14, padding: "11px 12px" }}>
      <div style={{ minWidth: 34, height: 34, padding: "0 6px", borderRadius: 10, background: sideBg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--df)", fontSize: 12, color: sideColor, flexShrink: 0, maxWidth: 80, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
        {row.sideLabel.length > 8 ? row.sideLabel.slice(0, 7) + "…" : row.sideLabel}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.question}</div>
        <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>
          {cents(row.lockedPriceBp)} · {usd(row.stakeCents)} stake
        </div>
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: statusColor, textTransform: "uppercase" }}>{statusText}</div>
        <div style={{ fontFamily: "var(--nf)", fontSize: 12, color: statusColor }}>{delta}</div>
      </div>
    </div>
  );
}
