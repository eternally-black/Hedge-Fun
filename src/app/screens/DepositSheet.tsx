"use client";

// The deposit sheet: pick a network, then send a stablecoin to the address it shows.
//
// It exists because the profile used to print the raw deposit wallet as inert text. That address is
// a Polygon contract; anyone who read it as "my address" and withdrew Solana USDC to it would be
// sending money to a string that means nothing on Solana. A network has to be CHOSEN before an
// address is shown, so the address is never separable from the chain it belongs to.
//
// Portalled onto the device surface and positioned absolutely — on desktop the app is a 402px phone
// mock, and a fixed overlay covers the monitor instead of the app.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { APP_SURFACE_ID } from "../appSurface";

type Api = (path: string, init?: RequestInit) => Promise<unknown>;

export type DepositChain = {
  chainId: string;
  name: string;
  address: string;
  minUsd: number;
  stables: string[];
};

const MUTED = { fontSize: 12, color: "var(--muted)" } as const;
const CAPS = {
  fontSize: 10,
  letterSpacing: ".14em",
  textTransform: "uppercase",
  color: "var(--muted)",
  fontWeight: 700,
} as const;

export function DepositSheet({ api, pusdMicro, onClose, onToast }: {
  api: Api;
  // The balance the app already polls for the HUD. This sheet does NOT fetch it again: two watchers
  // on one number would be two RPC reads to say the same thing.
  pusdMicro: string | null;
  onClose: () => void;
  onToast: (msg: string) => void;
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [chains, setChains] = useState<DepositChain[] | null>(null);
  const [picked, setPicked] = useState<DepositChain | null>(null);
  const [failed, setFailed] = useState(false);
  // What the balance was when this sheet opened. An ARRIVAL is an increase over THAT — not simply a
  // non-zero balance, or opening a funded account would announce money that came days ago.
  const [baseline, setBaseline] = useState<bigint | null>(null);
  const announced = useRef(false);
  const current = pusdMicro == null ? null : BigInt(pusdMicro);
  const landed = current !== null && baseline !== null && current > baseline;

  useEffect(() => {
    if (current !== null && baseline === null) setBaseline(current);
  }, [current, baseline]);

  useEffect(() => {
    if (landed && !announced.current) {
      announced.current = true;
      onToast("Deposit received");
    }
  }, [landed, onToast]);

  useEffect(() => setHost(document.getElementById(APP_SURFACE_ID)), []);

  // Declaring the attempt is what makes the SERVER watch this deposit: it snapshots the balance
  // baseline and starts the Transfer-log scan. Without it the watcher has no row to check — the
  // bridge lands USDC.e (which the pUSD number above never shows), nothing ever offers the
  // conversion, and this sheet says "Watching…" forever. The ops console declares by hand; a
  // tester's sheet must declare for them. Idempotent server-side: one active attempt per user.
  const declared = useRef(false);
  useEffect(() => {
    if (!picked || declared.current) return;
    declared.current = true;
    api("/api/real/funding", { method: "POST", body: "{}" }).catch(() => {
      declared.current = false; // transient failure — the next network pick retries
    });
  }, [picked, api]);

  useEffect(() => {
    let live = true;
    setFailed(false);
    // POST: the route only exports POST — it calls the bridge and caches per wallet.
    api("/api/real/deposit-address", { method: "POST" })
      .then((r) => {
        if (live) setChains(((r as { chains?: DepositChain[] }).chains ?? []).filter((c) => c.address));
      })
      .catch(() => {
        // The bridge mints these addresses. When it is unreachable there is nothing to show, and
        // inventing a fallback would be an invitation to send funds nowhere.
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [api]);

  if (!host) return null;

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      onToast("Copied to clipboard");
    } catch {
      onToast("Couldn't copy — select it manually");
    }
  };

  return createPortal(
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 65,
        background: "rgba(4,4,8,.72)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "flex-end",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxHeight: "88%",
          overflowY: "auto",
          background: "var(--bg2)",
          borderTop: "1px solid var(--line)",
          borderRadius: "20px 20px 0 0",
          padding: "16px 18px 22px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontFamily: "var(--df)", fontSize: 20, flex: 1 }}>
            {picked ? picked.name : "Deposit"}
          </div>
          <button
            type="button"
            onClick={picked ? () => setPicked(null) : onClose}
            style={{
              margin: 0,
              font: "inherit",
              background: "transparent",
              border: "1px solid var(--line)",
              color: "var(--muted)",
              borderRadius: 10,
              padding: "6px 12px",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            {picked ? "Back" : "Close"}
          </button>
        </div>

        {failed ? (
          <div style={{ ...MUTED, marginTop: 16, color: "var(--no)" }}>
            Deposit addresses are unavailable right now. Try again in a minute.
          </div>
        ) : !chains ? (
          <div style={{ ...MUTED, marginTop: 16 }}>Loading networks…</div>
        ) : picked ? (
          <>
            <div style={{ ...CAPS, marginTop: 16 }}>Send to this address</div>
            <button
              type="button"
              onClick={() => copy(picked.address)}
              style={{
                margin: "8px 0 0",
                font: "inherit",
                width: "100%",
                textAlign: "left",
                background: "var(--panel2)",
                border: "1px solid var(--line)",
                borderRadius: 12,
                padding: "12px 14px",
                cursor: "pointer",
                color: "var(--text)",
              }}
            >
              <div className="selectable" style={{ fontSize: 13, fontFamily: "monospace", wordBreak: "break-all", lineHeight: 1.4 }}>
                {picked.address}
              </div>
              <div style={{ ...CAPS, marginTop: 6, color: "var(--gold)" }}>Tap to copy</div>
            </button>

            <Row label="Network" value={picked.name} />
            <Row label="Send" value={picked.stables.length ? picked.stables.join(", ") : "USDC"} />
            <Row label="Minimum" value={`$${picked.minUsd}`} />

            {/* The two things that lose money here, stated where the address is, not in a footer. */}
            <div style={{ ...MUTED, marginTop: 14, lineHeight: 1.5 }}>
              This address only works on <strong style={{ color: "var(--text)" }}>{picked.name}</strong>. Sending
              from another network, or sending less than ${picked.minUsd}, means the funds do not arrive.
            </div>
            <div style={{ ...MUTED, marginTop: 8, lineHeight: 1.5 }}>
              Anything you send is bridged to Polygon and converted to pUSD, the collateral Polymarket
              trades in. It shows up as your real balance once the network confirms — usually a minute
              or two.
            </div>
            <div
              style={{
                marginTop: 12,
                paddingTop: 10,
                borderTop: "1px solid var(--line)",
                fontSize: 12,
                fontWeight: 700,
                color: landed ? "var(--yes)" : "var(--muted)",
              }}
            >
              {landed ? "Deposit received — your balance is updated." : "Watching for your deposit…"}
            </div>
          </>
        ) : (
          <>
            <div style={{ ...MUTED, marginTop: 10, lineHeight: 1.5 }}>
              Choose the network you are sending from. Each one has its own address — they are not
              interchangeable.
            </div>
            <div style={{ marginTop: 12 }}>
              {chains.map((c) => (
                <button
                  key={c.chainId}
                  type="button"
                  onClick={() => setPicked(c)}
                  style={{
                    margin: "0 0 8px",
                    font: "inherit",
                    width: "100%",
                    textAlign: "left",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    background: "var(--panel)",
                    border: "1px solid var(--line)",
                    borderRadius: 12,
                    padding: "11px 14px",
                    cursor: "pointer",
                    color: "var(--text)",
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{c.name}</div>
                    <div style={{ ...MUTED, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {c.stables.length ? c.stables.join(" · ") : "USDC"}
                    </div>
                  </div>
                  <div style={{ ...MUTED, flexShrink: 0 }}>min ${c.minUsd}</div>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>,
    host,
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        alignItems: "baseline",
        marginTop: 10,
        paddingTop: 10,
        borderTop: "1px solid var(--line)",
      }}
    >
      <div style={{ ...CAPS, flex: 1 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 700, textAlign: "right", minWidth: 0, wordBreak: "break-word" }}>
        {value}
      </div>
    </div>
  );
}
