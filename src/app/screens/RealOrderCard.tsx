"use client";

// The only place in the app that can spend real money. Nothing here may hide a failure or claim a
// fill that did not happen — an ambiguous exchange response says exactly that.
import { useCallback, useEffect, useState } from "react";
import { placeRealOrder, type Api, type RealCtx } from "@/lib/real-client";

type DeckCard = { id: string; question: string; yesPriceBp?: number; noPriceBp?: number };
type PositionRow = {
  id: string;
  marketId: string;
  question: string;
  side: "YES" | "NO";
  status: string;
  openSharesMicro: string;
  spendMicro: string;
  realizedPnlMicro: string;
};

const CARD = {
  background: "var(--panel)",
  border: "1px solid var(--line)",
  borderRadius: 18,
  padding: 16,
  marginTop: 14,
  textAlign: "left",
} as const;
const LABEL = {
  fontSize: 10,
  letterSpacing: ".14em",
  textTransform: "uppercase",
  color: "var(--muted)",
  fontWeight: 700,
} as const;
const MUTED = { fontSize: 12, color: "var(--muted)" } as const;
const ERR = { marginTop: 10, fontSize: 12, color: "var(--no)" } as const;
const BTN = { font: "inherit", fontSize: 14, padding: "10px 16px", borderRadius: 12, cursor: "pointer" } as const;
const PRIMARY = { ...BTN, background: "var(--gold)", color: "#1a1205", border: "none" } as const;
const GHOST = { ...BTN, background: "var(--panel2)", color: "var(--text)", border: "1px solid var(--line)" } as const;
const SMALL = { fontSize: 12, padding: "6px 12px" } as const;
const OFF = { opacity: 0.5, cursor: "default" } as const;
const FIELD = {
  font: "inherit",
  fontSize: 14,
  padding: "10px 12px",
  borderRadius: 12,
  color: "var(--text)",
  background: "var(--panel2)",
  border: "1px solid var(--line)",
} as const;

// The three the operator will actually hit; everything else shows its raw code, because inventing
// friendly prose for an unknown money error is how a real problem gets read as a typo.
const KNOWN: Record<string, string> = {
  stake_too_small: "below the market's minimum order size",
  no_liquidity: "the book cannot fill this size",
  geo_blocked: "trading is blocked from this location",
};

const short = (q: string, max = 60) => (q.length <= max ? q : `${q.slice(0, max - 1)}…`);
const usd = (micro: string) => `$${(Number(micro) / 1e6).toFixed(2)}`;
const signedUsd = (micro: string) => {
  const v = Number(micro) / 1e6;
  return `${v < 0 ? "−" : "+"}$${Math.abs(v).toFixed(2)}`;
};
const shares = (micro: string) => (Number(micro) / 1e6).toFixed(4);

function errText(e: unknown): string {
  const code = (e as { body?: { error?: string } }).body?.error;
  if (!code) return e instanceof Error ? e.message : String(e);
  return KNOWN[code] ?? code;
}

function resultText(res: { status: string; filledSharesMicro?: string }): string {
  switch (res.status) {
    case "filled":
    case "partial":
      return `${res.status} — ${shares(res.filledSharesMicro ?? "0")} shares`;
    case "killed":
      return "no fill — the market slot is free again";
    case "posted":
      return "posted, awaiting the exchange — the reconciler books it when the trade record lands";
    // NOT the same promise. "posted" carries an exchange order id and the reconciler really does
    // pick it up; "submitting" means the post outcome is unknown, and an attempt with no order id
    // is excluded from every reconcile scan (reconcile.ts filters `externalOrderId: { not: null }`).
    // Ops is paged by the stuck-attempt watcher and resolves it by hand, so promising an automatic
    // booking here was telling the user to wait for something that never runs.
    case "submitting":
      return "sent, outcome not yet confirmed — support is alerted and will reconcile this by hand";
    default:
      return `status: ${res.status}`;
  }
}

export function RealOrderCard({ api, ctx }: { api: Api; ctx: RealCtx }) {
  const [cards, setCards] = useState<DeckCard[]>([]);
  const [positions, setPositions] = useState<PositionRow[]>([]);
  const [marketId, setMarketId] = useState("");
  const [dollars, setDollars] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const [deck, pos] = await Promise.all([
      api("/api/deck").catch(() => null),
      api("/api/real/positions").catch((e: unknown) => {
        setError(errText(e));
        return null;
      }),
    ]);
    if (deck) setCards((deck as { cards?: DeckCard[] }).cards ?? []);
    if (pos) setPositions((pos as { positions?: PositionRow[] }).positions ?? []);
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const order = async (key: string, input: Parameters<typeof placeRealOrder>[2]) => {
    setBusy(key);
    setResult("");
    setError("");
    try {
      setResult(resultText(await placeRealOrder(api, ctx, input)));
      setDollars("");
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  const buy = (side: "YES" | "NO") => {
    if (!marketId) return setError("Choose a market first.");
    const stakeCents = Math.round(Number(dollars) * 100);
    if (!Number.isFinite(stakeCents) || stakeCents <= 0) return setError("Enter a positive dollar amount.");
    // Send the price this card is DISPLAYING (the same number the option label above renders), so
    // the server can refuse an order whose book moved after the deck was fetched. Omitted when the
    // deck row has no price — the server then skips the check rather than guessing a baseline.
    const card = cards.find((c) => c.id === marketId);
    const quotedPriceBp = side === "YES" ? card?.yesPriceBp : card?.noPriceBp;
    return order(`buy:${side}`, { marketId, side, stakeCents, dir: "ENTRY", quotedPriceBp });
  };

  return (
    <>
      <div style={CARD}>
        <div style={LABEL}>Order</div>
        <select value={marketId} onChange={(e) => setMarketId(e.target.value)} style={{ ...FIELD, width: "100%", marginTop: 10 }}>
          <option value="">Choose a market</option>
          {cards.map((c) => (
            <option key={c.id} value={c.id}>
              {short(c.question)} — YES {((c.yesPriceBp ?? 0) / 100).toFixed(1)}¢ / NO {((c.noPriceBp ?? 0) / 100).toFixed(1)}¢
            </option>
          ))}
        </select>
        <div style={{ display: "flex", gap: 10, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
          <input
            type="number"
            min="0"
            step="0.01"
            value={dollars}
            onChange={(e) => setDollars(e.target.value)}
            placeholder="0.00"
            style={{ ...FIELD, width: 110 }}
          />
          <button type="button" onClick={() => buy("YES")} disabled={busy !== null} style={{ ...PRIMARY, ...(busy ? OFF : {}) }}>
            {busy === "buy:YES" ? "…" : "Buy YES"}
          </button>
          <button type="button" onClick={() => buy("NO")} disabled={busy !== null} style={{ ...PRIMARY, ...(busy ? OFF : {}) }}>
            {busy === "buy:NO" ? "…" : "Buy NO"}
          </button>
        </div>
        <div style={{ ...MUTED, marginTop: 8 }}>The stake is the all-in cap: fee included, shares derived.</div>
        {result ? <div style={{ marginTop: 10, fontSize: 12 }}>{result}</div> : null}
        {error ? <div style={ERR}>{error}</div> : null}
      </div>

      <div style={CARD}>
        <div style={LABEL}>Positions</div>
        {positions.length === 0 ? (
          <div style={{ ...MUTED, marginTop: 6 }}>none yet</div>
        ) : (
          positions.map((p) => {
            const open = p.openSharesMicro !== "0";
            return (
              <div key={p.id} style={{ borderTop: "1px solid var(--line)", marginTop: 8, paddingTop: 8 }}>
                <div style={{ fontSize: 13 }}>{short(p.question, 72)}</div>
                <div style={{ marginTop: 4, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={MUTED}>{p.side}</span>
                  {open ? <span style={MUTED}>{shares(p.openSharesMicro)} open</span> : null}
                  <span style={MUTED}>{usd(p.spendMicro)} in</span>
                  <span style={MUTED}>{signedUsd(p.realizedPnlMicro)} realized</span>
                  <span style={MUTED}>{p.status.toLowerCase()}</span>
                  {open ? (
                    <button
                      type="button"
                      onClick={() => order(`exit:${p.id}`, { marketId: p.marketId, side: p.side, dir: "EXIT" })}
                      disabled={busy !== null}
                      style={{ ...GHOST, ...SMALL, ...(busy ? OFF : {}) }}
                    >
                      {busy === `exit:${p.id}` ? "…" : "Close"}
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
