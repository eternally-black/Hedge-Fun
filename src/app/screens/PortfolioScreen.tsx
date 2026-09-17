"use client";

import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { type Me, usd } from "../ui";
import { REAL_BALANCE_POLL_MS } from "@/lib/config";
import type { StockPortfolioResponse, StockPositionRow } from "@/lib/api-types";
import { useBuyReal } from "../useBuyReal";
import { StockConsentSheet } from "./StockConsentSheet";

type Api = (path: string, init?: RequestInit) => Promise<unknown>;

// The Portfolio (Stocklana): every tokenized-stock lot the user owns, paper and on-chain, in one
// list. Open lots carry their live mark and a two-tap Sell — paper rows sell paper, on-chain rows
// swap back to the wallet. BUYING is the deck's job (one swipe, in the app's current mode), so no
// row offers it. Closed lots collapse behind a toggle — they are history, not the thing you came to
// look at. Pending real buys show as a strip while the poller confirms them.
export function PortfolioScreen({
  api,
  me,
  onRefreshMe,
  onToast,
  stocksUsdCents,
  onOpenWallet,
}: {
  api: Api;
  me: Me | null;
  onRefreshMe: () => void | Promise<void>;
  onToast: (m: string) => void;
  // The REAL · STOCKS pocket. Read and polled by page.tsx (one owner for the whole app), shown here
  // as a one-line link into the wallet sheet — the address, the copy button and the funding
  // instructions live there now, in the same place as the other two pockets.
  stocksUsdCents: number | null;
  onOpenWallet: () => void;
}) {
  const [data, setData] = useState<StockPortfolioResponse | null>(null);
  const [closedOpen, setClosedOpen] = useState(false);
  const [selling, setSelling] = useState<string | null>(null);
  // The armed row id — ONE arm at a time across the screen, so a stale arm on a row you scrolled
  // past can never turn the next tap into a sale.
  const [armed, setArmed] = useState<string | null>(null);
  const armTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(armTimer.current), []);
  const arm = useCallback((key: string) => {
    setArmed(key);
    window.clearTimeout(armTimer.current);
    armTimer.current = window.setTimeout(() => setArmed(null), 3000);
  }, []);
  const disarm = useCallback(() => {
    window.clearTimeout(armTimer.current);
    setArmed(null);
  }, []);

  const load = useCallback(async () => {
    try {
      const r = (await api("/api/stocks/portfolio")) as StockPortfolioResponse;
      setData(r);
    } catch (e) {
      console.error(e);
    }
  }, [api]);

  const real = useBuyReal({
    api,
    me,
    onToast,
    onRefreshMe,
    ctx: { wallets: data?.wallets ?? [], stockConsent: data?.stockConsent ?? false, sponsored: data?.sponsored },
    onDone: () => { void load(); void onRefreshMe(); },
  });
  const replayPending = real.replayPending;
  const sellReal = real.sellReal;
  const replayed = useRef(false); // the pending-buy replay runs once per mount — see the effect below

  // Selling a REAL lot is the same two-tap as a paper sell, but the work happens in the hook (build,
  // sign, submit, confirm). `selling` is shared: a row is either paper or on-chain, never both.
  const sellOnChain = useCallback(
    async (row: StockPositionRow) => {
      setSelling(row.id);
      try {
        await sellReal(row.id, { symbol: row.symbol, ctx: { wallets: data?.wallets ?? [], stockConsent: data?.stockConsent ?? false, sponsored: data?.sponsored } });
      } catch (e) {
        // The hook toasts its own failures; this is the backstop for a rejected promise, so a
        // thrown sell can never leave the row silent after "Selling…".
        console.error(e);
        onToast("Couldn't sell — try again");
      } finally {
        setSelling(null);
      }
    },
    // `data` whole, not its three fields: with the catch above the compiler infers the object and
    // refuses to keep a narrower manual dep list. The callback only feeds an onClick, so a new
    // identity per poll costs nothing.
    [data, onToast, sellReal],
  );

  // Initial load + one replay of any pending real buy (a tab that died before /confirm). If the
  // replay confirmed anything, refetch so the new lot appears and say so.
  // ONCE per mount, guarded by a ref: `replayPending` changes identity with every `me` refresh, so
  // without the guard every buy and every sell re-ran this — a second portfolio load and a second
  // replay of the same pending attempts. The poll effect below is the only repeating reader.
  useEffect(() => {
    if (replayed.current) return;
    replayed.current = true;
    let alive = true;
    void (async () => {
      await load();
      try {
        const n = await replayPending();
        if (!alive) return;
        if (n > 0) {
          await load();
          onToast("Confirmed a pending Solana buy");
        }
      } catch (e) {
        console.error(e);
      }
    })();
    return () => { alive = false; };
  }, [load, onToast, replayPending]);

  // Visibility-gated re-poll: a hidden tab is a read for a number nobody is looking at. Coming back
  // re-reads immediately, which is also the moment someone returns from the wallet they just bought
  // from. Same pattern as the HUD's real-balance poll.
  useEffect(() => {
    let timer: number | undefined;
    const stop = () => window.clearInterval(timer);
    const start = () => {
      stop();
      timer = window.setInterval(() => void load(), REAL_BALANCE_POLL_MS);
    };
    const onVis = () => {
      if (document.hidden) return stop();
      void load();
      start();
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
    };
  }, [load]);

  const sell = useCallback(
    async (row: StockPositionRow) => {
      setSelling(row.id);
      try {
        const r = (await api("/api/stocks/sell", {
          method: "POST",
          body: JSON.stringify({ positionId: row.id }),
        })) as { proceedsCents: number; pnlCents: number };
        const pnl = r.pnlCents;
        onToast(`Sold ${row.symbol}: ${pnl >= 0 ? "+" : ""}${usd(pnl)}`);
        await load();
        await onRefreshMe();
      } catch (e) {
        const status = (e as { status?: number }).status;
        if (status === 409) onToast("Already sold");
        else if (status === 502) onToast("Price unavailable — try again");
        // A network drop or a 500 used to be console-only: the row said "Selling…" and then nothing.
        else { console.error(e); onToast("Couldn't sell — try again"); }
      } finally {
        setSelling(null);
      }
    },
    [api, load, onRefreshMe, onToast],
  );

  const open = data?.open ?? [];
  const closed = data?.closed ?? [];
  const pending = data?.pendingAttempts ?? [];
  const paper = data?.totals.paper ?? { costCents: 0, valueCents: 0, pnlCents: 0 };
  const realTotals = data?.totals.real ?? { costCents: 0, valueCents: 0, pnlCents: 0 };
  const hasReal = realTotals.costCents > 0 || open.some((r) => r.mode === "REAL");

  return (
    <>
      <div className="hf-scroll" style={{ position: "absolute", inset: 0, overflowY: "auto", padding: "6px 16px 20px" }}>
        <div style={{ fontFamily: "var(--df)", fontSize: 26, marginTop: 4 }}>Portfolio</div>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>Tokenized stocks you own — paper and on-chain.</div>

        {/* One line, one tap into the wallet sheet. The balance is stated here because this is the
            screen you check before selling — but nothing is funded from here. */}
        <button
          type="button"
          onClick={onOpenWallet}
          style={{ margin: "14px 0 0", font: "inherit", width: "100%", display: "flex", alignItems: "center", gap: 10, background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 14, padding: "11px 13px", cursor: "pointer", color: "inherit", textAlign: "left" }}
        >
          <span style={{ flex: 1, fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--muted)", fontWeight: 700 }}>Wallet</span>
          <span style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 15, color: "var(--gold)" }}>{stocksUsdCents == null ? "—" : usd(stocksUsdCents)}</span>
          <span style={{ fontSize: 9, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--muted)" }}>Real · Stocks ›</span>
        </button>

        <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
          <TotalTile label="Paper" totals={paper} />
          {hasReal ? <TotalTile label="On-chain" totals={realTotals} /> : null}
        </div>

        {pending.length > 0 ? (
          <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 6 }}>
            {pending.map((p) => (
              <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 12, padding: "9px 12px", fontSize: 12, color: "var(--muted)" }}>
                <span aria-hidden="true" style={{ display: "inline-block", width: 12, height: 12, borderRadius: "50%", border: "2px solid var(--line)", borderTopColor: "var(--energy)", animation: "hfSpin .8s linear infinite" }} />
                <span>Confirming {p.symbol} · {usd(p.stakeCents)}…</span>
              </div>
            ))}
          </div>
        ) : null}

        {data === null ? (
          <div style={{ textAlign: "center", marginTop: 80, color: "var(--muted)", fontSize: 13 }}>Loading…</div>
        ) : open.length === 0 && closed.length === 0 ? (
          <div style={{ textAlign: "center", marginTop: 80, color: "var(--muted)", fontSize: 13 }}>
            No stocks yet. Swipe right on the Stocks deck to buy your first one.
          </div>
        ) : (
          <>
            {open.length > 0 ? (
              <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 8 }}>
                {open.map((row) => (
                  <OpenRow
                    key={row.id}
                    row={row}
                    armedSell={armed === row.id}
                    selling={selling === row.id}
                    onArmSell={() => arm(row.id)}
                    onSell={() => {
                      disarm();
                      void (row.mode === "REAL" ? sellOnChain(row) : sell(row));
                    }}
                  />
                ))}
              </div>
            ) : null}

            {closed.length > 0 ? (
              <div style={{ marginTop: 20 }}>
                <button
                  type="button"
                  onClick={() => setClosedOpen((o) => !o)}
                  style={{ margin: 0, font: "inherit", background: "none", border: "none", padding: 0, cursor: "pointer", display: "flex", alignItems: "center", gap: 8, color: "var(--muted)", fontSize: 11, letterSpacing: ".14em", textTransform: "uppercase", fontWeight: 700 }}
                >
                  Closed · {closed.length}
                  <span aria-hidden="true" style={{ fontSize: 10, transform: closedOpen ? "rotate(180deg)" : "none", transition: "transform .15s" }}>▾</span>
                </button>
                {closedOpen ? (
                  <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                    {closed.map((row) => (
                      <ClosedRow key={row.id} row={row} />
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>

      <StockConsentSheet
        open={real.consentOpen}
        busy={real.busy}
        sponsored={data?.sponsored ?? false}
        onAccept={real.acceptConsent}
        onClose={real.closeConsent}
      />
    </>
  );
}

// One total tile: the big number is what the lots are worth now, the line under it is the P&L
// against what they cost.
function TotalTile({ label, totals }: { label: string; totals: { costCents: number; valueCents: number; pnlCents: number } }) {
  const pnl = totals.pnlCents;
  return (
    <div style={{ flex: 1, background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 14, padding: "12px 13px" }}>
      <div style={{ fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--muted)", fontWeight: 700 }}>{label}</div>
      <div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 22, marginTop: 4 }}>{usd(totals.valueCents)}</div>
      <div style={{ fontSize: 11, marginTop: 3, color: pnl >= 0 ? "var(--yes)" : "var(--no)" }}>
        {signed(pnl)}
        <span style={{ color: "var(--muted)" }}> (cost {usd(totals.costCents)})</span>
      </div>
    </div>
  );
}

// "+$1.05" / "−$0.40" (U+2212) — usd() formats the magnitude, the sign is ours.
function signed(cents: number): string {
  return `${cents >= 0 ? "+" : "−"}${usd(Math.abs(cents))}`;
}

// Display quantity: raw base units → whole shares, scaled by the Token-2022 UI multiplier when the
// mint carries one (so it matches what Phantom shows). Four decimals is honest precision.
function fmtQty(row: StockPositionRow): string {
  const raw = Number(row.qtyBase) / 10 ** row.decimals;
  const scaled = raw * (row.uiMultiplierMicro ? row.uiMultiplierMicro / 1e6 : 1);
  return `${scaled.toFixed(4)} sh`;
}

function OpenRow({
  row,
  armedSell,
  selling,
  onArmSell,
  onSell,
}: {
  row: StockPositionRow;
  armedSell: boolean;
  selling: boolean;
  onArmSell: () => void;
  onSell: () => void;
}) {
  const pnl = row.pnlCents;
  const pnlColor = pnl == null ? "var(--muted)" : pnl >= 0 ? "var(--yes)" : "var(--no)";
  return (
    <div style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 14, padding: "12px 13px" }}>
      <div style={{ display: "flex", gap: 11 }}>
        <Logo url={row.logoUrl} symbol={row.symbol} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 700, fontSize: 13 }}>{row.symbol}</span>
            <span style={{ fontSize: 11, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.name}</span>
            {row.mode === "REAL" ? (
              row.source === "WALLET" ? (
                <span style={{ fontSize: 10, fontWeight: 700, color: "var(--gold)", background: "color-mix(in srgb,var(--gold) 14%,var(--panel))", border: "1px solid color-mix(in srgb,var(--gold) 40%,var(--line))", padding: "2px 7px", borderRadius: 20 }}>◎ in wallet</span>
              ) : row.txSig ? (
                <a href={`https://solscan.io/tx/${row.txSig}`} target="_blank" rel="noreferrer" style={{ fontSize: 10, fontWeight: 700, color: "var(--gold)", background: "color-mix(in srgb,var(--gold) 14%,var(--panel))", border: "1px solid color-mix(in srgb,var(--gold) 40%,var(--line))", padding: "2px 7px", borderRadius: 20, textDecoration: "none" }}>◎ on-chain</a>
              ) : (
                <span style={{ fontSize: 10, fontWeight: 700, color: "var(--gold)", background: "color-mix(in srgb,var(--gold) 14%,var(--panel))", border: "1px solid color-mix(in srgb,var(--gold) 40%,var(--line))", padding: "2px 7px", borderRadius: 20 }}>◎ on-chain</span>
              )
            ) : (
              <span style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", background: "var(--panel2)", border: "1px solid var(--line)", padding: "2px 7px", borderRadius: 20 }}>PAPER</span>
            )}
            {row.source === "HEDGE" ? (
              <span style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", background: "var(--panel2)", border: "1px solid var(--line)", padding: "2px 7px", borderRadius: 20 }}>hedge</span>
            ) : null}
          </div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 3 }}>
            {fmtQty(row)} · {row.source === "WALLET" ? "imported at" : "entry"} {usd(row.entryPriceCents)} → now {row.priceCents == null ? "—" : usd(row.priceCents)}
          </div>
          <div style={{ fontSize: 11, marginTop: 2, color: pnlColor }}>
            {pnl == null ? "—" : signed(pnl)}
            {!row.fresh ? <span style={{ color: "var(--muted)" }}> · cached</span> : null}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
        {/* Same two-tap for both modes — a REAL sell is a swap back to USDC, which is no more
            undoable than a paper one, so it gets the same "are you sure" gesture and the same look. */}
        <button
          type="button"
          disabled={selling}
          onClick={armedSell ? onSell : onArmSell}
          style={{
            margin: 0, font: "inherit",
            padding: "7px 12px", borderRadius: 10,
            background: armedSell ? "var(--gold)" : "transparent",
            color: armedSell ? "#1a1205" : "var(--muted)",
            border: "1px solid " + (armedSell ? "var(--gold)" : "var(--line)"),
            fontWeight: 700, fontSize: 11,
            cursor: selling ? "default" : "pointer",
            opacity: selling ? 0.5 : 1,
            whiteSpace: "nowrap",
          }}
        >
          {selling ? "Selling…" : armedSell ? "Sell?" : row.mode === "REAL" ? "◎ Sell on Solana" : "Sell"}
        </button>
      </div>
    </div>
  );
}

function ClosedRow({ row }: { row: StockPositionRow }) {
  const pnl = row.pnlCents;
  const pnlColor = pnl == null ? "var(--muted)" : pnl >= 0 ? "var(--yes)" : "var(--no)";
  return (
    <div style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 14, padding: "10px 13px", display: "flex", alignItems: "center", gap: 11 }}>
      <Logo url={row.logoUrl} symbol={row.symbol} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 13 }}>{row.symbol}</div>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
          {row.closeReason === "wallet" ? "moved in wallet" : "sold"}
          {/* The sale has its own signature — the buy link on the open row is gone once it closes. */}
          {row.sellTxSig ? (
            <>
              {" · "}
              <a href={`https://solscan.io/tx/${row.sellTxSig}`} target="_blank" rel="noreferrer" style={{ color: "var(--gold)" }}>
                ◎ sale
              </a>
            </>
          ) : null}
        </div>
      </div>
      {pnl != null ? (
        <div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 13, color: pnlColor, whiteSpace: "nowrap" }}>
          {signed(pnl)}
        </div>
      ) : null}
    </div>
  );
}

// Read-only row for the unified history sheet (BalanceSheet): open or closed, paper or on-chain,
// deck or hedge. No actions here — selling and buying stay on the Portfolio screen.
const PILL: CSSProperties = { fontSize: 10, fontWeight: 700, color: "var(--muted)", background: "var(--panel2)", border: "1px solid var(--line)", padding: "2px 7px", borderRadius: 20 };
export function StockHistoryRow({ row }: { row: StockPositionRow }) {
  const pnl = row.pnlCents;
  const pnlColor = pnl == null ? "var(--muted)" : pnl >= 0 ? "var(--yes)" : "var(--no)";
  const closed = row.closedAt != null;
  const sub = closed
    ? `${row.closeReason === "wallet" ? "moved in wallet" : "sold"}${row.proceedsCents != null ? ` · ${usd(row.proceedsCents)}` : ""}`
    : `${fmtQty(row)} · ${usd(row.entryPriceCents)}${row.priceCents != null ? ` → ${usd(row.priceCents)}` : ""}`;
  return (
    <div style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 14, padding: "10px 13px", display: "flex", alignItems: "center", gap: 11, opacity: closed ? 0.8 : 1 }}>
      <Logo url={row.logoUrl} symbol={row.symbol} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700, fontSize: 13 }}>
          <span>{row.symbol}</span>
          <span style={row.mode === "REAL" ? { ...PILL, color: "var(--gold)" } : PILL}>{row.mode === "REAL" ? "◎ on-chain" : "PAPER"}</span>
          {row.source === "HEDGE" && <span style={PILL}>🛡 hedge</span>}
          {row.source === "WALLET" && <span style={PILL}>imported</span>}
        </div>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</div>
      </div>
      {pnl != null && <div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 13, color: pnlColor, whiteSpace: "nowrap" }}>{signed(pnl)}</div>}
    </div>
  );
}

// 36px round logo with an initials fallback — the same shape every row in the app uses.
function Logo({ url, symbol }: { url: string | null; symbol: string }) {
  if (url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt="" width={36} height={36} style={{ width: 36, height: 36, borderRadius: "50%", objectFit: "cover", flexShrink: 0, background: "var(--panel2)" }} />;
  }
  return (
    <div style={{ width: 36, height: 36, borderRadius: "50%", background: "var(--panel2)", border: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--df)", fontSize: 12, color: "var(--muted)", flexShrink: 0 }}>
      {symbol.slice(0, 3)}
    </div>
  );
}
