"use client";

// How much one real swipe spends, opened from the STAKE chip on the card itself.
//
// It edits the number the server will actually debit (users.realStakeCents) — /api/real/intent reads
// the stake from the row, never from a swipe's request body, so a stale tab can never be the thing
// that decides an amount. Saving happens on an explicit choice, not on every keystroke: a half-typed
// "1" on the way to "10" must never become the stake someone swipes with.
//
// Portalled onto the device surface and absolutely positioned — on desktop the app is a 402px phone
// mock, and a fixed overlay would cover the monitor instead of the app.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { APP_SURFACE_ID } from "../appSurface";
import { REAL_STAKE_PRESETS_CENTS } from "@/lib/config";

type Api = (path: string, init?: RequestInit) => Promise<unknown>;

const MUTED = { fontSize: 12, color: "var(--muted)" } as const;

const asDollars = (cents: number) => (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2));

export function StakeSheet({ stakeCents, minCents, maxCents, api, onClose, onSaved, onToast }: {
  stakeCents: number;
  minCents: number;
  maxCents: number;
  api: Api;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onToast: (msg: string) => void;
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [draft, setDraft] = useState(() => asDollars(stakeCents));
  const [busy, setBusy] = useState(false);

  useEffect(() => setHost(document.getElementById(APP_SURFACE_ID)), []);
  if (!host) return null;

  const parsed = Math.round(Number(draft) * 100);
  const valid = draft.trim() !== "" && Number.isFinite(parsed) && parsed >= minCents && parsed <= maxCents;

  const save = async (cents: number) => {
    if (busy) return;
    if (cents === stakeCents) return onClose(); // nothing to write; closing IS the outcome
    setBusy(true);
    try {
      await api("/api/real/stake", { method: "POST", body: JSON.stringify({ stakeCents: cents }) });
      await onSaved();
      onClose();
    } catch {
      onToast("Couldn't save the stake");
      setBusy(false);
    }
  };

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 68,
        background: "rgba(4,4,8,.7)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 18,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 330,
          background: "var(--bg2)",
          border: "1px solid var(--line)",
          borderRadius: 20,
          padding: "18px 18px 16px",
          boxShadow: "0 24px 60px -12px rgba(0,0,0,.8)",
        }}
      >
        <div style={{ fontFamily: "var(--df)", fontSize: 19, lineHeight: 1.2 }}>Stake per swipe</div>
        <div style={{ ...MUTED, marginTop: 6, lineHeight: 1.45 }}>
          Every call buys this much of the market. The platform fee is charged on top, so the total
          debit is slightly more than the stake.
        </div>

        <div style={{ display: "flex", gap: 6, marginTop: 14 }}>
          {REAL_STAKE_PRESETS_CENTS.map((preset) => {
            const on = parsed === preset;
            return (
              <button
                key={preset}
                type="button"
                disabled={busy}
                onClick={() => setDraft(asDollars(preset))}
                style={{
                  margin: 0,
                  font: "inherit",
                  flex: 1,
                  padding: "10px 0",
                  borderRadius: 12,
                  background: on ? "var(--gold)" : "var(--panel2)",
                  color: on ? "#1a1205" : "var(--text)",
                  border: "1px solid " + (on ? "var(--gold)" : "var(--line)"),
                  fontWeight: 700,
                  fontSize: 13,
                  cursor: busy ? "default" : "pointer",
                }}
              >
                ${asDollars(preset)}
              </button>
            );
          })}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: "var(--muted)" }}>$</div>
          <input
            inputMode="decimal"
            autoFocus
            value={draft}
            disabled={busy}
            // Digits and one dot only — the server takes integer cents, and a stray character here
            // would otherwise surface as a generic 400 on an amount the user thought they had typed.
            onChange={(e) => setDraft(e.target.value.replace(/[^0-9.]/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && valid) void save(parsed);
            }}
            style={{
              font: "inherit",
              fontSize: 20,
              fontWeight: 700,
              flex: 1,
              minWidth: 0,
              background: "var(--panel2)",
              border: "1px solid " + (valid || draft.trim() === "" ? "var(--line)" : "var(--no)"),
              borderRadius: 12,
              padding: "10px 12px",
              color: "var(--text)",
            }}
          />
        </div>

        <div style={{ ...MUTED, marginTop: 8 }}>
          {valid || draft.trim() === ""
            ? `Between $${asDollars(minCents)} and $${asDollars(maxCents)}.`
            : `Enter between $${asDollars(minCents)} and $${asDollars(maxCents)}.`}
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button
            type="button"
            onClick={busy ? undefined : onClose}
            disabled={busy}
            style={{
              margin: 0,
              font: "inherit",
              flex: 1,
              padding: "12px 16px",
              borderRadius: 12,
              background: "transparent",
              color: "var(--muted)",
              border: "1px solid var(--line)",
              fontWeight: 700,
              fontSize: 13,
              cursor: busy ? "default" : "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={valid && !busy ? () => void save(parsed) : undefined}
            disabled={!valid || busy}
            style={{
              margin: 0,
              font: "inherit",
              flex: 1,
              padding: "12px 16px",
              borderRadius: 12,
              background: "var(--gold)",
              color: "#1a1205",
              border: "none",
              fontWeight: 700,
              fontSize: 13,
              cursor: valid && !busy ? "pointer" : "default",
              opacity: valid && !busy ? 1 : 0.5,
            }}
          >
            {busy ? "Saving…" : "Set stake"}
          </button>
        </div>
      </div>
    </div>,
    host,
  );
}
