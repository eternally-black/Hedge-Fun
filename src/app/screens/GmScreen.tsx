"use client";

import { type Me } from "../ui";

// Daily GM check-in (ported from app design). One tap = streak day + login bonus (1 pt, P-2) +
// the GM marks today. Wired to /api/login-mark via onGM. Weekly dots reflect the current streak.
export function GmScreen({ me, busy, onGM }: { me: Me | null; busy: boolean; onGM: () => void }) {
  const done = me?.loginMarkedToday ?? false;
  const streak = me?.streak.level ?? 0;
  const dayLabels = ["M", "T", "W", "T", "F", "S", "S"];
  const filled = streak % 7; // days completed this week before today

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center", background: "radial-gradient(120% 70% at 50% 30%, color-mix(in srgb,var(--energy) 22%,transparent), transparent 60%)" }}>
      <div style={{ fontSize: 64, animation: "hfFlame 1.6s ease-in-out infinite" }}>🔥</div>
      <div style={{ fontFamily: "var(--df)", fontSize: 50, lineHeight: 0.95, marginTop: 10 }}>GM, DEGEN</div>
      <div style={{ fontSize: 14, color: "var(--muted)", maxWidth: 260, marginTop: 8, textWrap: "pretty" }}>
        {done ? "You're checked in. Streak is safe — come back tomorrow." : "Check in to keep your streak burning."}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 24 }}>
        {dayLabels.map((l, i) => {
          const isDone = i < filled || (done && i === filled);
          const isToday = i === filled;
          return (
            <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5 }}>
              <div style={{ width: 30, height: 30, borderRadius: 10, background: isDone ? "color-mix(in srgb,var(--gold) 22%,transparent)" : "var(--panel)", border: `1.5px solid ${isToday ? "var(--energy)" : isDone ? "var(--gold)" : "var(--line)"}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, color: isDone ? "var(--gold)" : "var(--muted)" }}>
                {isDone ? "🔥" : isToday && !done ? "☀" : ""}
              </div>
              <div style={{ fontSize: 8, color: "var(--muted)" }}>{l}</div>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 26, background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 16, padding: "14px 22px", display: "flex", gap: 22 }}>
        <div><div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 22, color: "var(--energy)" }}>+1</div><div style={{ fontSize: 9, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)" }}>Point</div></div>
        <div style={{ width: 1, background: "var(--line)" }} />
        <div><div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 22, color: "var(--gold)" }}>🔥 {streak}</div><div style={{ fontSize: 9, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)" }}>Streak</div></div>
      </div>

      <div
        onClick={done || busy ? undefined : onGM}
        style={{ marginTop: 26, width: "100%", maxWidth: 300, background: done ? "var(--panel)" : "linear-gradient(135deg,var(--energy),color-mix(in srgb,var(--energy) 55%,#000))", color: done ? "var(--muted)" : "#fff", fontFamily: "var(--df)", fontSize: 22, padding: 16, borderRadius: 18, cursor: done || busy ? "default" : "pointer", boxShadow: done ? "none" : "0 14px 30px -8px color-mix(in srgb,var(--energy) 60%,transparent)", border: done ? "1px solid var(--line)" : "none" }}
      >
        {done ? "✓ Checked in — see you tomorrow" : "☀ Claim & keep streak"}
      </div>
    </div>
  );
}
