"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { APP_SURFACE_ID } from "../appSurface";

// The xStocks consent sheet. A bottom sheet in the same visual language as the real-money consent
// modal (RealModeCard.ConsentModal): portalled onto the device surface, absolutely positioned so it
// covers the phone mock on desktop rather than the whole monitor.
//
// The checkbox is the point. This is a self-declaration that the user is not a US person and not in
// a restricted jurisdiction — a claim only they can make, and one the button must not make for them.
export function StockConsentSheet({ open, busy, sponsored, onAccept, onClose }: {
  open: boolean;
  busy: boolean;
  /** The server pays the Solana network fee for these swaps — say so before the user agrees. */
  sponsored?: boolean;
  onAccept: () => void;
  onClose: () => void;
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => setHost(document.getElementById(APP_SURFACE_ID)), []);
  if (!open || !host) return null;
  // The body (and its checkbox state) mounts fresh on every open: re-opening the sheet must not
  // remember a previous tick — the declaration is per-acceptance.
  return createPortal(<SheetBody busy={busy} sponsored={sponsored} onAccept={onAccept} onClose={onClose} />, host);
}

function SheetBody({ busy, sponsored, onAccept, onClose }: { busy: boolean; sponsored?: boolean; onAccept: () => void; onClose: () => void }) {
  const [checked, setChecked] = useState(false);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 60,
        background: "rgba(4,4,8,.66)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 402,
          background: "var(--bg2)",
          border: "1px solid var(--line)",
          borderBottom: "none",
          borderRadius: "22px 22px 0 0",
          padding: "20px 18px 22px",
          boxShadow: "0 -24px 60px -12px rgba(0,0,0,.8)",
          animation: "hfRise .22s ease",
        }}
      >
        <div style={{ fontFamily: "var(--df)", fontSize: 20, lineHeight: 1.2 }}>Buying real stocks on Solana</div>

        <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 10, lineHeight: 1.55 }}>
          These are tokenized stocks (xStocks by Backed). You buy them in YOUR own wallet through
          Jupiter — HedgeFun never holds your funds and cannot sell for you.
        </div>
        <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 8, lineHeight: 1.55 }}>
          Stock cards are thematic exposure, not a hedge of your actual bill — a fare or a fuel price
          can rise while the stock falls. &apos;Energy stocks&apos; cards track an energy-equity basket
          (XLEx), not crude oil. Sizing is a product rule, not hedge math.
        </div>
        {sponsored ? (
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 8, lineHeight: 1.55 }}>
            Network fees for these swaps are paid by HedgeFun.
          </div>
        ) : null}
        <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 8, lineHeight: 1.55 }}>
          xStocks are not available to US persons or in restricted jurisdictions.
        </div>

        <label style={{ display: "flex", alignItems: "flex-start", gap: 10, marginTop: 16, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            style={{ marginTop: 2, width: 16, height: 16, accentColor: "var(--energy)", flexShrink: 0 }}
          />
          <span style={{ fontSize: 12, color: "var(--text)", lineHeight: 1.5 }}>
            I am not a US person and not in a restricted jurisdiction, and I accept the{" "}
            <a href="https://xstocks.com/terms" target="_blank" rel="noreferrer" style={{ color: "var(--energy)", textDecoration: "underline" }}>
              xStocks terms
            </a>
          </span>
        </label>

        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 18 }}>
          <button
            type="button"
            onClick={busy || !checked ? undefined : onAccept}
            disabled={busy || !checked}
            style={{
              margin: 0,
              font: "inherit",
              width: "100%",
              padding: "13px 16px",
              borderRadius: 14,
              background: "var(--energy)",
              color: "#06070a",
              border: "none",
              fontWeight: 800,
              fontSize: 14,
              cursor: busy || !checked ? "default" : "pointer",
              opacity: busy || !checked ? 0.5 : 1,
            }}
          >
            {busy ? "Saving…" : "I understand, continue"}
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
              borderRadius: 14,
              background: "transparent",
              color: "var(--muted)",
              border: "1px solid var(--line)",
              fontWeight: 700,
              fontSize: 13,
              cursor: busy ? "default" : "pointer",
            }}
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
