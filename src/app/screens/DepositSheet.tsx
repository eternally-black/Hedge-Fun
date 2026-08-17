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
import { useEffect, useState } from "react";
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

// Deposit-watch cadence. Bounded on purpose: this is a real RPC read each time, and a sheet left
// open on a forgotten tab must not keep asking the chain about a deposit nobody is sending.
const WATCH_FAST_MS = 4_000;
const WATCH_FAST_FOR_MS = 3 * 60_000;
const WATCH_SLOW_MS = 20_000;
const WATCH_STOP_MS = 15 * 60_000;

const MUTED = { fontSize: 12, color: "var(--muted)" } as const;
const CAPS = {
  fontSize: 10,
  letterSpacing: ".14em",
  textTransform: "uppercase",
  color: "var(--muted)",
  fontWeight: 700,
} as const;

export function DepositSheet({ api, onClose, onToast, onFunded }: {
  api: Api;
  onClose: () => void;
  onToast: (msg: string) => void;
  onFunded?: () => void | Promise<void>;
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [chains, setChains] = useState<DepositChain[] | null>(null);
  const [picked, setPicked] = useState<DepositChain | null>(null);
  const [failed, setFailed] = useState(false);
  const [landed, setLanded] = useState(false);

  useEffect(() => setHost(document.getElementById(APP_SURFACE_ID)), []);

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

  // Watch for the deposit ONLY while this sheet is open.
  //
  // A balance moves in exactly two situations: a deposit arrives, or an order fills — and the order
  // path already refreshes explicitly. So there is nothing to gain from a background timer during
  // normal play, and every tick of one is an RPC read per user for a number that did not change.
  // Someone staring at this sheet is the one moment a deposit is expected, so the watch lives here
  // and dies with the sheet. Elsewhere, the far cheaper focus trigger in page.tsx covers it.
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    let baseline: bigint | null = null;
    const startedAt = Date.now();

    const read = async () => {
      if (!alive) return;
      try {
        const r = (await api("/api/real/wallet")) as { pusdMicro?: string | null };
        const now = r.pusdMicro == null ? null : BigInt(r.pusdMicro);
        if (now !== null) {
          // First successful read is the baseline, not a deposit — otherwise opening the sheet with
          // a funded balance would announce money that arrived days ago.
          if (baseline === null) baseline = now;
          else if (now > baseline) {
            baseline = now;
            if (alive) {
              setLanded(true);
              onToast("Deposit received");
              void onFunded?.();
            }
            return; // stop watching: the thing being waited for happened
          }
        }
      } catch {
        // An RPC hiccup is not worth surfacing here — the next pass re-reads, and the balance shown
        // everywhere else is unaffected.
      }
      if (!alive) return;
      // Attentive early, then back off: a bridged deposit usually lands inside a couple of minutes,
      // and after that the person is no longer watching a clock.
      const elapsed = Date.now() - startedAt;
      if (elapsed > WATCH_STOP_MS) return;
      timer = window.setTimeout(() => void read(), elapsed < WATCH_FAST_FOR_MS ? WATCH_FAST_MS : WATCH_SLOW_MS);
    };

    void read();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [api, onToast, onFunded]);

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
              <div style={{ fontSize: 13, fontFamily: "monospace", wordBreak: "break-all", lineHeight: 1.4 }}>
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
