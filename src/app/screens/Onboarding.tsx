"use client";

// Onboarding / auth overlay (ported from app design). Each button drives Privy straight to ONE
// method (no method-picker step): Twitter → OAuth redirect, Email → email-entry. The parent passes
// method-scoped login callbacks (login({ loginMethods: ['twitter'|'email'] })).
export function Onboarding({ onTwitter, onEmail }: { onTwitter: () => void; onEmail: () => void }) {
  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 90, background: "radial-gradient(120% 80% at 50% 0%, color-mix(in srgb,var(--energy) 26%,transparent), transparent 55%), var(--bg)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 32, textAlign: "center" }}>
      <div style={{ fontSize: 13, letterSpacing: ".3em", textTransform: "uppercase", color: "var(--energy)", fontWeight: 700 }}>Hedge Fun</div>
      <div style={{ fontFamily: "var(--df)", fontSize: 60, lineHeight: 0.9, marginTop: 14, textWrap: "balance" }}>CALL IT.<br />FARM IT.</div>
      <div style={{ fontSize: 15, color: "var(--muted)", marginTop: 14, maxWidth: 300, textWrap: "pretty" }}>Test app — swipe real prediction markets with virtual cash. Zero risk, all dopamine. Stack points.</div>
      <div style={{ display: "flex", gap: 9, marginTop: 28, fontSize: 11, color: "var(--muted)" }}>
        {["⟶ YES", "⟵ NO", "↑ SKIP"].map((t) => (
          <span key={t} style={{ background: "var(--panel)", padding: "6px 12px", borderRadius: 20, border: "1px solid var(--line)" }}>{t}</span>
        ))}
      </div>
      <div style={{ width: "100%", maxWidth: 330, marginTop: 34, display: "flex", flexDirection: "column", gap: 10 }}>
        <button type="button" onClick={onTwitter} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, background: "#fff", color: "#111", fontWeight: 700, padding: 15, borderRadius: 16, cursor: "pointer", fontSize: 15, border: "none", width: "100%" }}>
          𝕏 Continue with Twitter
        </button>
        <button type="button" onClick={onEmail} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, background: "var(--panel)", color: "var(--text)", fontWeight: 700, padding: 15, borderRadius: 16, cursor: "pointer", border: "1px solid var(--line)", fontSize: 15, width: "100%" }}>
          ✉ Continue with Email
        </button>
      </div>
      <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 18 }}>No wallet. No seed phrase. No risk.</div>
    </div>
  );
}
