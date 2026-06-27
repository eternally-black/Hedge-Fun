"use client";

import { memo } from "react";
import { type Me, num, usd } from "../ui";

// Top HUD: points / streak / virtual-$ chips + the shard→artifact progress strip.
// Ported from app design. Points pop animates on a +N event (pop prop). memo'd + stable
// callbacks from the parent, so it only re-renders when me/pop actually change.
export const Hud = memo(function Hud({ me, pop, onShards, onGM, onBalance, onBell }: { me: Me | null; pop: { amt: number; color: string } | null; onShards: () => void; onGM: () => void; onBalance: () => void; onBell: () => void }) {
  const shards = me?.shards ?? 0;
  const per = me?.shardsPerArtifact ?? 20;
  const shardPct = Math.round((shards / per) * 100);
  const unread = me?.unreadResults ?? 0;

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

        <div onClick={onGM} style={{ display: "flex", alignItems: "center", gap: 6, background: "var(--panel)", border: "1px solid var(--line)", padding: "6px 12px", borderRadius: 30, cursor: "pointer" }}>
          <div style={{ fontSize: 15, animation: "hfFlame 1.6s ease-in-out infinite" }}>🔥</div>
          <Stat value={me ? String(me.streak.level) : "—"} label="Streak" />
        </div>

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <div onClick={onBalance} style={{ display: "flex", alignItems: "center", gap: 7, background: "var(--panel)", border: "1px solid var(--line)", padding: "6px 11px", borderRadius: 30, cursor: "pointer" }}>
            <div style={{ lineHeight: 1, textAlign: "right" }}>
              <div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 14, color: "var(--yes)" }}>{me ? usd(me.cashCents) : "—"}</div>
              <div style={{ fontSize: 8, letterSpacing: ".14em", color: "var(--muted)", textTransform: "uppercase", marginTop: 1 }}>
                {me && me.lockedCents > 0 ? `+ ${usd(me.lockedCents)} locked ›` : "Cash ›"}
              </div>
            </div>
          </div>

          <div onClick={onBell} style={{ position: "relative", width: 38, height: 38, borderRadius: "50%", background: "var(--panel)", border: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontSize: 17 }}>
            <span style={{ display: "inline-block", animation: unread > 0 ? "hfBellSwing 2.6s ease-in-out infinite" : undefined }}>🔔</span>
            {unread > 0 && (
              <div style={{ position: "absolute", top: -4, right: -4, minWidth: 18, height: 18, padding: "0 4px", borderRadius: 9, background: "var(--no)", color: "#fff", fontFamily: "var(--nf)", fontWeight: 700, fontSize: 10, display: "flex", alignItems: "center", justifyContent: "center", animation: "hfBadgePop .4s ease", boxShadow: "0 0 0 2px var(--bg)" }}>
                {unread}
              </div>
            )}
          </div>
        </div>
      </div>

      <div onClick={onShards} style={{ marginTop: 9, display: "flex", alignItems: "center", gap: 9, cursor: "pointer" }}>
        <div style={{ fontSize: 9, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--gold)", fontWeight: 700, whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 4 }}>◆ {shards}/{per}</div>
        <div style={{ flex: 1, height: 7, borderRadius: 6, background: "var(--panel2)", overflow: "hidden", border: "1px solid var(--line)" }}>
          <div style={{ height: "100%", width: `${shardPct}%`, background: "linear-gradient(90deg,#c98a1e,var(--gold))", borderRadius: 6 }} />
        </div>
        <div style={{ fontSize: 9, color: "var(--muted)", whiteSpace: "nowrap" }}>→ artifact</div>
      </div>
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
