"use client";

import { memo } from "react";
import { type Me, num, usd, usdFromMicro } from "../ui";

// Top HUD: points / streak / money chips + the shard→artifact progress strip.
// Ported from app design. Points pop animates on a +N event (pop prop). memo'd + stable
// callbacks from the parent, so it only re-renders when me/pop actually change.
// realPusdMicro: on-chain spendable balance, passed in only when the account is in REAL mode. Kept
// as a prop rather than read here so the HUD stays a pure render of state someone else owns — and so
// paper mode costs no extra fetch. null = in real mode but the balance has not arrived (or the RPC
// failed), which renders "—" rather than a misleading $0.00.
//
// `pocket` is the whole point of this chip: the app holds THREE separate pots of money (play money,
// the user's own Solana wallet, the Polymarket balance), and a chip that states one of them while
// the screen spends another is the HUD lying about the user's money. page.tsx derives it from the
// screen, so the number always belongs to what is on screen. Named by PURPOSE, never by token.
export type Pocket = "paper" | "stocks" | "predictions";

export const Hud = memo(function Hud({ me, pop, pocket, realPusdMicro, stocksUsdCents, onShards, onGM, onBalance, onBell }: { me: Me | null; pop: { amt: number; color: string } | null; pocket: Pocket; realPusdMicro?: string | null; stocksUsdCents: number | null; onShards: () => void; onGM: () => void; onBalance: () => void; onBell: () => void }) {
  const isReal = me?.real.mode === "REAL";
  // Which rendering wins. Stocks falls back to paper while the balance is unknown (no wallet yet,
  // first load): a gold "—" where the user expects their cash reads as money that went missing.
  const showStocks = pocket === "stocks" && stocksUsdCents !== null;
  const showPredictions = pocket === "predictions" && isReal;
  const real = showStocks || showPredictions;
  const amount = showStocks
    ? usd(stocksUsdCents)
    : showPredictions
      ? realPusdMicro == null
        ? "—"
        : usdFromMicro(realPusdMicro)
      : me
        ? usd(me.cashCents)
        : "—";
  const label = showStocks
    ? "Real · Stocks ›"
    : showPredictions
      ? "Real · Predictions ›"
      : me && me.lockedCents > 0
        ? `Paper · +${usd(me.lockedCents)} in play ›`
        : "Paper ›";
  const shards = me?.shards ?? 0;
  const per = me?.shardsPerArtifact ?? 20;
  const shardPct = Math.round((shards / per) * 100);
  const unread = (me?.unreadResults ?? 0) + (me?.unreadStockAlerts ?? 0); // settled calls + stock profit alerts

  return (
    <div style={{ position: "relative", zIndex: 30, padding: "16px 16px 10px", background: "linear-gradient(180deg, color-mix(in srgb, var(--bg) 92%, transparent), transparent)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 7, background: "var(--panel)", border: "1px solid var(--line)", padding: "6px 11px 6px 8px", borderRadius: 30 }}>
          {pop && pop.amt > 0 && (
            <div style={{ position: "absolute", left: 0, right: 0, top: -3, textAlign: "center", fontFamily: "var(--nf)", fontWeight: 700, fontSize: 15, color: pop.color, animation: "hfPts .65s ease-out forwards", pointerEvents: "none", textShadow: "0 1px 6px rgba(0,0,0,.6)", zIndex: 5 }}>+{pop.amt}</div>
          )}
          <div style={{ width: 22, height: 22, borderRadius: "50%", background: "color-mix(in srgb,var(--energy) 22%,transparent)", display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid color-mix(in srgb,var(--energy) 50%,transparent)" }}>
            <div style={{ width: 9, height: 9, borderRadius: "50%", background: "var(--energy)", boxShadow: "0 0 10px var(--energy)" }} />
          </div>
          <Stat value={me ? num(me.points.total) : "—"} label="Points" />
        </div>

        <button type="button" onClick={onGM} aria-label="Streak — open GM check-in" style={{ background: "var(--panel)", border: "1px solid var(--line)", margin: 0, font: "inherit", color: "inherit", display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 30, cursor: "pointer" }}>
          <div aria-hidden="true" style={{ fontSize: 15, animation: "hfFlame 1.6s ease-in-out infinite" }}>🔥</div>
          <Stat value={me ? String(me.streak.level) : "—"} label="Streak" />
        </button>

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <button type="button" onClick={onBalance} aria-label={showStocks ? "Real stocks balance — open wallet" : showPredictions ? "Real predictions balance — open wallet" : "Cash balance — open wallet"} style={{ background: "var(--panel)", border: "1px solid var(--line)", margin: 0, font: "inherit", color: "inherit", display: "flex", alignItems: "center", gap: 7, padding: "6px 11px", borderRadius: 30, cursor: "pointer" }}>
            <div style={{ lineHeight: 1, textAlign: "right" }}>
              {/* gold = real money (either real pocket), green = play money. */}
              <div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 14, color: real ? "var(--gold)" : "var(--yes)" }}>{amount}</div>
              <div style={{ fontSize: 8, letterSpacing: ".14em", color: "var(--muted)", textTransform: "uppercase", marginTop: 1 }}>{label}</div>
            </div>
          </button>

          <button type="button" onClick={onBell} aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"} style={{ margin: 0, font: "inherit", color: "inherit", position: "relative", width: 38, height: 38, borderRadius: "50%", background: "var(--panel)", border: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontSize: 17, padding: 0 }}>
            <span aria-hidden="true" style={{ display: "inline-block", animation: unread > 0 ? "hfBellSwing 2.6s ease-in-out infinite" : undefined }}>🔔</span>
            {unread > 0 && (
              // span (not div) so the badge is valid phrasing content inside the <button>
              <span aria-hidden="true" style={{ position: "absolute", top: -4, right: -4, minWidth: 18, height: 18, padding: "0 4px", borderRadius: 9, background: "var(--no)", color: "#fff", fontFamily: "var(--nf)", fontWeight: 700, fontSize: 10, display: "flex", alignItems: "center", justifyContent: "center", animation: "hfBadgePop .4s ease", boxShadow: "0 0 0 2px var(--bg)" }}>
                {unread}
              </span>
            )}
          </button>
        </div>
      </div>

      <button type="button" onClick={onShards} aria-label={`Shards ${shards} of ${per} — open Vault`} style={{ background: "none", border: "none", padding: 0, font: "inherit", color: "inherit", width: "100%", marginTop: 9, display: "flex", alignItems: "center", gap: 9, cursor: "pointer" }}>
        <div style={{ fontSize: 9, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--gold)", fontWeight: 700, whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 4 }}>◆ {shards}/{per}</div>
        <div style={{ flex: 1, height: 7, borderRadius: 6, background: "var(--panel2)", overflow: "hidden", border: "1px solid var(--line)" }}>
          <div style={{ height: "100%", width: `${shardPct}%`, background: "linear-gradient(90deg,#c98a1e,var(--gold))", borderRadius: 6 }} />
        </div>
        <div style={{ fontSize: 9, color: "var(--muted)", whiteSpace: "nowrap" }}>→ artifact</div>
      </button>
    </div>
  );
});

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div style={{ lineHeight: 1 }}>
      <div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 14, color: "var(--text)" }}>{value}</div>
      <div style={{ fontSize: 8, letterSpacing: ".14em", color: "var(--muted)", textTransform: "uppercase", marginTop: 1 }}>{label}</div>
    </div>
  );
}
