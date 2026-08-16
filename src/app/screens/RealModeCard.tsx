"use client";

// The Paper/Real switch, and the terms gate in front of it. Lives in the profile because that is
// where a mode belongs — it is a property of the account, not of the screen you happen to be on.
//
// The switch is not a toggle over a boolean: turning it ON is the moment a user first accepts the
// terms, so the control is deliberately two-step the first time and one tap thereafter. Turning it
// OFF is never gated by anything — getting back to play money must always work.
import { useState } from "react";
import type { Me } from "../ui";
import { useRealCtx } from "../useRealCtx";
import { provisionReal } from "@/lib/real-client";
import { REAL_TERMS, REAL_TERMS_ACK, REAL_TERMS_INTRO, REAL_TERMS_TITLE } from "@/lib/real-terms";

type Api = (path: string, init?: RequestInit) => Promise<unknown>;

const CARD = {
  background: "var(--panel)",
  border: "1px solid var(--line)",
  borderRadius: 14,
  padding: "12px 14px",
} as const;
const LABEL = {
  fontSize: 10,
  letterSpacing: ".14em",
  textTransform: "uppercase",
  color: "var(--muted)",
  fontWeight: 700,
} as const;
const MUTED = { fontSize: 12, color: "var(--muted)" } as const;

export function RealModeCard({ me, api, onRefresh }: { me: Me | null; api: Api; onRefresh: () => Promise<void> }) {
  const [termsOpen, setTermsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { ctx } = useRealCtx(me);

  const real = me?.real;
  if (!real) return null; // pre-boot; the card appears with the first /api/me

  const isReal = real.mode === "REAL";
  // Consented, but to an older text: they have to read the new one. Shown as a distinct state rather
  // than silently re-opening the terms, so the difference between "never agreed" and "agreed to
  // something we have since changed" is visible to the person it concerns.
  const staleConsent = real.consentAt !== null && real.consentVersion !== real.termsVersion;

  const setMode = async (on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/real/mode", { method: "POST", body: JSON.stringify({ real: on }) });
      await onRefresh();
    } catch (e) {
      const status = (e as { status?: number }).status;
      // 403/409 here means consent is missing or stale — the terms sheet is the answer, not an error.
      if (status === 403 || status === 409) setTermsOpen(true);
      else setError("Couldn't switch mode. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const provision = async () => {
    if (!ctx) return;
    setBusy(true);
    setError(null);
    try {
      await provisionReal(api, ctx);
      await onRefresh();
    } catch (e) {
      setError((e as { body?: { error?: string } }).body?.error ?? "Setup failed. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      // The version is sent back so the server can refuse consent to a text this client never
      // rendered — a stale tab must not be able to accept on the user's behalf.
      await api("/api/real/consent", {
        method: "POST",
        body: JSON.stringify({ accept: true, version: real.termsVersion }),
      });
      await api("/api/real/mode", { method: "POST", body: JSON.stringify({ real: true }) });
      await onRefresh();
      setTermsOpen(false);
    } catch {
      setError("Couldn't enable real money. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div style={{ marginTop: 22, ...LABEL }}>Mode</div>
      <div style={{ ...CARD, marginTop: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: isReal ? "var(--gold)" : "var(--text)" }}>
              {isReal ? "Real money" : "Paper money"}
            </div>
            <div style={{ ...MUTED, marginTop: 2 }}>
              {isReal
                ? "Swipes place real orders and spend real funds."
                : staleConsent
                  ? "The terms changed since you agreed — read them again to switch."
                  : "Play money. Nothing you swipe costs anything."}
            </div>
          </div>
          <Switch
            on={isReal}
            busy={busy}
            onChange={(next) => {
              // OFF is unconditional. ON needs consent to the CURRENT text; without it the sheet
              // opens instead of the request being fired and bounced.
              if (!next) return void setMode(false);
              if (real.consentVersion === real.termsVersion) return void setMode(true);
              setTermsOpen(true);
            }}
          />
        </div>

        {isReal && real.depositWallet ? (
          <div style={{ marginTop: 10, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
            <div style={{ ...MUTED, fontSize: 10, letterSpacing: ".1em", textTransform: "uppercase" }}>Wallet</div>
            <div style={{ fontSize: 12, fontFamily: "monospace", wordBreak: "break-all", marginTop: 2 }}>
              {real.depositWallet}
            </div>
          </div>
        ) : null}
        {isReal && !real.depositWallet ? (
          <div style={{ marginTop: 10, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
            {/* Deliberately its own step, not folded into the first swipe: provisioning derives the
                deposit wallet and the exchange credentials, which is several seconds and two device
                signatures. Hiding that inside a gesture would make a swipe feel broken. */}
            <div style={MUTED}>One-time setup: create your trading wallet before you can place orders.</div>
            <button
              type="button"
              onClick={busy || !ctx ? undefined : provision}
              disabled={busy || !ctx}
              style={{
                margin: 0,
                font: "inherit",
                width: "100%",
                marginTop: 8,
                padding: "10px 16px",
                borderRadius: 12,
                background: "var(--gold)",
                color: "#1a1205",
                border: "none",
                fontWeight: 700,
                fontSize: 13,
                cursor: busy || !ctx ? "default" : "pointer",
                opacity: busy || !ctx ? 0.5 : 1,
              }}
            >
              {busy ? "Setting up…" : ctx ? "Set up trading wallet" : "Waiting for wallet…"}
            </button>
          </div>
        ) : null}
        {error ? <div style={{ fontSize: 12, color: "var(--no)", marginTop: 8 }}>{error}</div> : null}
      </div>

      {termsOpen ? <TermsSheet busy={busy} onAccept={accept} onClose={() => setTermsOpen(false)} /> : null}
    </>
  );
}

function Switch({ on, busy, onChange }: { on: boolean; busy: boolean; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="Real money mode"
      disabled={busy}
      onClick={() => onChange(!on)}
      style={{
        margin: 0,
        font: "inherit",
        flexShrink: 0,
        width: 52,
        height: 30,
        borderRadius: 999,
        border: "1px solid " + (on ? "var(--gold)" : "var(--line)"),
        background: on ? "color-mix(in srgb,var(--gold) 30%,var(--panel2))" : "var(--panel2)",
        position: "relative",
        cursor: busy ? "default" : "pointer",
        opacity: busy ? 0.6 : 1,
        transition: "background .15s, border-color .15s",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: on ? 25 : 3,
          width: 22,
          height: 22,
          borderRadius: 999,
          background: on ? "var(--gold)" : "var(--muted)",
          transition: "left .15s",
        }}
      />
    </button>
  );
}

// Full-screen because it must be read, not dismissed past. Accept is the only way forward; the close
// control is explicit and leaves the user in paper mode.
function TermsSheet({ busy, onAccept, onClose }: { busy: boolean; onAccept: () => void; onClose: () => void }) {
  const [ack, setAck] = useState(false);
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: "color-mix(in srgb,var(--bg) 92%,#000)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ padding: "18px 18px 10px", borderBottom: "1px solid var(--line)" }}>
        <div style={{ fontFamily: "var(--df)", fontSize: 22, lineHeight: 1.15 }}>{REAL_TERMS_TITLE}</div>
        <div style={{ ...MUTED, marginTop: 8 }}>{REAL_TERMS_INTRO}</div>
      </div>

      <div className="hf-scroll" style={{ flex: 1, overflowY: "auto", padding: "14px 18px" }}>
        {REAL_TERMS.map((c) => (
          <div key={c.title} style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{c.title}</div>
            <div style={{ ...MUTED, marginTop: 4, lineHeight: 1.5 }}>{c.body}</div>
          </div>
        ))}
      </div>

      <div style={{ padding: "12px 18px 18px", borderTop: "1px solid var(--line)", background: "var(--bg)" }}>
        <label style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
            style={{ marginTop: 2, width: 18, height: 18, flexShrink: 0, accentColor: "var(--gold)" }}
          />
          <span style={{ fontSize: 12, lineHeight: 1.45 }}>{REAL_TERMS_ACK}</span>
        </label>
        <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            style={{
              margin: 0,
              font: "inherit",
              flex: 1,
              padding: "12px 16px",
              borderRadius: 12,
              background: "var(--panel2)",
              color: "var(--text)",
              border: "1px solid var(--line)",
              fontWeight: 700,
              fontSize: 13,
              cursor: busy ? "default" : "pointer",
            }}
          >
            Stay on paper
          </button>
          <button
            type="button"
            onClick={ack && !busy ? onAccept : undefined}
            disabled={!ack || busy}
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
              cursor: ack && !busy ? "pointer" : "default",
              opacity: ack && !busy ? 1 : 0.5,
            }}
          >
            {busy ? "Enabling…" : "Enable real money"}
          </button>
        </div>
      </div>
    </div>
  );
}
