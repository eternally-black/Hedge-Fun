"use client";

import { useState } from "react";
import { type Me } from "../ui";

type Api = (path: string, init?: RequestInit) => Promise<unknown>;

// The Vault (ported from app design): shard→artifact progress ring, artifacts owned, and streak
// recovery. Recovery is REAL — wired to /api/recover (spends 1 artifact to revive a burned
// streak, F7/P-10). Shows the revive CTA only when the streak is BURNED_RECOVERABLE.
export function VaultScreen({ me, api, onRefresh }: { me: Me | null; api: Api; onRefresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const shards = me?.shards ?? 0;
  const artifacts = me?.artifacts ?? 0;
  const burned = me?.streak.state === "BURNED_RECOVERABLE";
  const circumference = 326.7;
  const dash = `${((shards / 20) * circumference).toFixed(0)} ${circumference}`;

  const revive = async () => {
    setBusy(true);
    try {
      await api("/api/recover", { method: "POST" });
      await onRefresh();
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="hf-scroll" style={{ position: "absolute", inset: 0, overflowY: "auto", padding: "8px 18px 20px", textAlign: "center" }}>
      <div style={{ fontFamily: "var(--df)", fontSize: 30, marginTop: 6 }}>The Vault</div>
      <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>Correct calls drop shards. 20 shards forge 1 artifact.</div>

      <div style={{ margin: "20px auto 0", width: 150, height: 150, position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <svg viewBox="0 0 120 120" style={{ position: "absolute", inset: 0, transform: "rotate(-90deg)" }}>
          <circle cx="60" cy="60" r="52" fill="none" stroke="var(--panel2)" strokeWidth="10" />
          <circle cx="60" cy="60" r="52" fill="none" stroke="var(--gold)" strokeWidth="10" strokeLinecap="round" strokeDasharray={dash} />
        </svg>
        <div style={{ position: "relative" }}>
          <div style={{ fontSize: 40, filter: "drop-shadow(0 0 12px var(--gold))" }}>◆</div>
          <div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 20, color: "var(--gold)", marginTop: 2 }}>{shards}/20</div>
        </div>
      </div>
      <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 6 }}>{20 - shards} more shards to forge your next artifact</div>

      <div style={{ marginTop: 22, textAlign: "left", fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--muted)", fontWeight: 700 }}>Artifacts · revive a burned streak</div>
      <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
        {Array.from({ length: 3 }).map((_, i) => {
          const owned = i < artifacts;
          return (
            <div key={i} style={{ flex: 1, aspectRatio: "1", borderRadius: 18, background: owned ? "linear-gradient(150deg,color-mix(in srgb,var(--gold) 30%,var(--panel)),var(--panel))" : "var(--panel)", border: owned ? "1px solid color-mix(in srgb,var(--gold) 40%,var(--line))" : "1px dashed var(--line)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, opacity: owned ? 1 : 0.5, animation: owned ? "hfPulse 2.4s ease-in-out infinite" : "none" }}>
              <div style={{ fontSize: 30 }}>{owned ? "🛡" : "＋"}</div>
              <div style={{ fontSize: 10, color: owned ? "var(--gold)" : "var(--muted)", fontWeight: 700 }}>{owned ? "Artifact" : "Locked"}</div>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 22, borderRadius: 20, overflow: "hidden", border: `1px solid ${burned ? "color-mix(in srgb,var(--no) 50%,var(--line))" : "var(--line)"}` }}>
        <div style={{ padding: 16, background: burned ? "color-mix(in srgb,var(--no) 12%,var(--panel))" : "var(--panel)", textAlign: "left" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ fontSize: 26 }}>{burned ? "💀" : "🛡"}</div>
            <div>
              <div style={{ fontFamily: "var(--df)", fontSize: 20, color: burned ? "var(--no)" : "var(--gold)" }}>{burned ? "Streak burned out" : "Streak protected"}</div>
              <div style={{ fontSize: 11, color: "var(--muted)" }}>{burned ? "You have 3 days to revive it with an artifact before it resets to 0." : "Hold an artifact and a missed day won't reset you."}</div>
            </div>
          </div>
          {burned && (
            <div onClick={busy || artifacts < 1 ? undefined : revive} style={{ marginTop: 14, background: artifacts < 1 ? "var(--panel2)" : "linear-gradient(135deg,var(--gold),#c98a1e)", color: artifacts < 1 ? "var(--muted)" : "#1a1205", fontFamily: "var(--df)", fontSize: 18, textAlign: "center", padding: 13, borderRadius: 14, cursor: busy || artifacts < 1 ? "default" : "pointer" }}>
              {artifacts < 1 ? "No artifact to spend" : "🛡 Spend 1 Artifact → Revive streak"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
