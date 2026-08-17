"use client";

// The Paper/Real switch, and the consent notice in front of it. Lives in the profile because that is
// where a mode belongs — it is a property of the account, not of the screen you happen to be on.
//
// Consent is a ONE-TIME notice, not a gate the user re-reads on every flip: once the current terms
// version is accepted the toggle moves freely in both directions. Turning it OFF is never gated by
// anything at all — getting back to play money must always work.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Me } from "../ui";
import { useRealCtx } from "../useRealCtx";
import { provisionReal } from "@/lib/real-client";
import { APP_SURFACE_ID } from "../appSurface";
import { DepositSheet } from "./DepositSheet";

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

export function RealModeCard({ me, api, onRefresh, onToast, onFunded }: {
  me: Me | null;
  api: Api;
  onRefresh: () => Promise<void>;
  onToast: (msg: string) => void;
  onFunded: () => void | Promise<void>;
}) {
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [depositOpen, setDepositOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { ctx } = useRealCtx(me);

  const real = me?.real;
  if (!real) return null; // pre-boot; the card appears with the first /api/me

  const isReal = real.mode === "REAL";
  const consented = real.consentVersion === real.termsVersion;
  // Consented, but to an older text: they see the notice once more. Surfaced as its own line rather
  // than silently re-opening, so "never agreed" and "agreed to something we have since changed" do
  // not look the same to the person they concern.
  const staleConsent = real.consentAt !== null && !consented;

  const setMode = async (on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/real/mode", { method: "POST", body: JSON.stringify({ real: on }) });
      await onRefresh();
    } catch (e) {
      const status = (e as { status?: number }).status;
      // 403/409 means consent is missing or stale — the notice is the answer, not an error message.
      if (status === 403 || status === 409) setNoticeOpen(true);
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

  // Native clipboard; the toast is the app's own, so a copy here reads the same as a copy anywhere
  // else. Failure is reported rather than swallowed — a silent no-op on an address someone is about
  // to paste into an exchange withdrawal is the worst outcome available.
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      onToast("Copied to clipboard");
    } catch {
      onToast("Couldn't copy — select it manually");
    }
  };

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      // The version goes back with the acceptance so the server can refuse consent to a text this
      // client never rendered — a stale tab must not accept on the user's behalf.
      await api("/api/real/consent", {
        method: "POST",
        body: JSON.stringify({ accept: true, version: real.termsVersion }),
      });
      await api("/api/real/mode", { method: "POST", body: JSON.stringify({ real: true }) });
      await onRefresh();
      setNoticeOpen(false);
    } catch (e) {
      // Rendered INSIDE the modal. It used to live on the card behind it, so a failed accept looked
      // like the button doing nothing at all.
      setError((e as { body?: { error?: string } }).body?.error ?? "Couldn't enable real money. Try again.");
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
                  ? "The terms changed — one more tap to switch."
                  : "Play money. Nothing you swipe costs anything."}
            </div>
          </div>
          <Switch
            on={isReal}
            busy={busy}
            onChange={(next) => {
              // OFF is unconditional. ON shows the notice only until the CURRENT version is accepted;
              // after that the switch just flips.
              if (!next) return void setMode(false);
              if (consented) return void setMode(true);
              setNoticeOpen(true);
            }}
          />
        </div>

        {/* The deposit wallet address is deliberately NOT printed here. It is a Polygon contract, and
            shown loose in a profile it reads as "my address" — the next step is a Solana withdrawal
            to a string that means nothing on Solana. An address is only ever shown behind a chosen
            network, in DepositSheet. */}
        {isReal && real.depositWallet ? (
          <div style={{ marginTop: 10, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
            <button
              type="button"
              onClick={() => setDepositOpen(true)}
              style={{
                margin: 0,
                font: "inherit",
                width: "100%",
                padding: "10px 16px",
                borderRadius: 12,
                background: "var(--panel2)",
                border: "1px solid var(--line)",
                color: "var(--text)",
                fontWeight: 700,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              Deposit
            </button>
          </div>
        ) : null}

        {isReal && !real.depositWallet ? (
          <div style={{ marginTop: 10, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
            {/* Its own step, not folded into the first swipe: provisioning derives the deposit wallet
                and the exchange credentials, which is several seconds and two device signatures.
                Hiding that inside a gesture would make a swipe feel broken. */}
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

        {error && !noticeOpen ? <div style={{ fontSize: 12, color: "var(--no)", marginTop: 8 }}>{error}</div> : null}
      </div>

      {noticeOpen ? (
        <ConsentModal busy={busy} error={error} onAccept={accept} onClose={() => setNoticeOpen(false)} />
      ) : null}
      {depositOpen ? (
        <DepositSheet api={api} onClose={() => setDepositOpen(false)} onToast={onToast} onFunded={onFunded} />
      ) : null}
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

// A SMALL notice, not a wall of text. The full terms live at /terms, where they can be read at your
// own pace and linked to — a document that only ever appears as a sheet someone is trying to dismiss
// is not a document anyone has read.
//
// Portalled onto the device surface and positioned ABSOLUTELY rather than fixed: on desktop the app
// renders as a 402px phone mock centred in the page, and a fixed overlay spreads across the entire
// monitor instead of covering the app.
function ConsentModal({ busy, error, onAccept, onClose }: {
  busy: boolean;
  error: string | null;
  onAccept: () => void;
  onClose: () => void;
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => setHost(document.getElementById(APP_SURFACE_ID)), []); // exists once Frame rendered
  if (!host) return null;

  return createPortal(
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 60,
        background: "rgba(4,4,8,.66)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 18,
      }}
    >
      <div
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
        <div style={{ fontFamily: "var(--df)", fontSize: 19, lineHeight: 1.2 }}>Switching to real money</div>
        <div style={{ ...MUTED, marginTop: 8, lineHeight: 1.5 }}>
          Swipes will place live orders with your own funds, and they spend immediately — there is no
          confirmation step. You can lose everything you deposit.
        </div>
        <div style={{ ...MUTED, marginTop: 8, lineHeight: 1.5 }}>
          By continuing you agree to the{" "}
          <a
            href="/terms"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "var(--gold)", textDecoration: "underline" }}
          >
            real money terms
          </a>
          .
        </div>

        {error ? <div style={{ fontSize: 12, color: "var(--no)", marginTop: 10 }}>{error}</div> : null}

        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16 }}>
          <button
            type="button"
            onClick={busy ? undefined : onAccept}
            disabled={busy}
            style={{
              margin: 0,
              font: "inherit",
              width: "100%",
              padding: "12px 16px",
              borderRadius: 12,
              background: "var(--gold)",
              color: "#1a1205",
              border: "none",
              fontWeight: 700,
              fontSize: 13,
              cursor: busy ? "default" : "pointer",
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? "Enabling…" : "I understand"}
          </button>
          <button
            type="button"
            onClick={busy ? undefined : onClose}
            disabled={busy}
            style={{
              margin: 0,
              font: "inherit",
              width: "100%",
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
            Stay on paper
          </button>
        </div>
      </div>
    </div>,
    host,
  );
}
