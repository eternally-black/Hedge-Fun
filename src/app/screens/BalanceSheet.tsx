"use client";

import { useCallback, useState } from "react";
import { type Me, usd } from "../ui";
import { usePredictionHistory } from "./usePredictionHistory";
import { HistoryRow } from "./HistoryRow";

type Api = (path: string, init?: RequestInit) => Promise<unknown>;

// Balance bottom-sheet (opened by tapping the Cash tile). Shows the Cash / Locked / Total split, a
// Top-Up button (free once, then 1 artifact), and the prediction history (same /api/history rows via
// usePredictionHistory — shared with HistorySheet). All money is derived from `me` during render —
// no mirrored server state.
export function BalanceSheet({ me, api, onClose, onTopupDone, onToast }: {
  me: Me | null;
  api: Api;
  onClose: () => void;
  onTopupDone: () => void | Promise<void>;
  onToast: (msg: string) => void;
}) {
  const { rows, pending, nowMs } = usePredictionHistory(api);
  const [busy, setBusy] = useState(false);

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
    // Backdrop is a real button: click/Enter/Escape closes (matches the overlay-click-to-close).
    // ponytail: reset to a plain div via button-reset inline styles so it looks identical.
    <div
      role="button"
      tabIndex={0}
      aria-label="Close"
      onClick={onClose}
      // Escape closes from anywhere in the sheet; Enter/Space only when the backdrop itself is the
      // focus target (not bubbled up from an inner control like the Top-Up button).
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.preventDefault(); onClose(); }
        else if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); onClose(); }
      }}
      style={{ position: "absolute", inset: 0, zIndex: 50, background: "rgba(4,4,8,.6)", backdropFilter: "blur(8px)", display: "flex", flexDirection: "column", justifyContent: "flex-end", animation: "hfRise .28s ease", border: "none", cursor: "default" }}
    >
      <div onClick={(e) => e.stopPropagation()} className="hf-scroll" style={{ background: "var(--bg2)", borderRadius: "28px 28px 0 0", borderTop: "1px solid var(--line)", padding: "8px 18px 22px", maxHeight: "82%", overflowY: "auto" }}>
        <div style={{ width: 42, height: 5, borderRadius: 4, background: "var(--line)", margin: "0 auto 14px" }} />

        {/* Cash / Locked / Total split panel */}
        <div style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 18, padding: "16px 18px", marginBottom: 14 }}>
          <div style={{ fontSize: 10, letterSpacing: ".14em", color: "var(--muted)", textTransform: "uppercase" }}>Cash</div>
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
      <div style={{ fontSize: 10, letterSpacing: ".12em", color: "var(--muted)", textTransform: "uppercase" }}>{label}</div>
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
      type="button"
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
