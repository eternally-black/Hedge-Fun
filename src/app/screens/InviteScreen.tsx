"use client";

import { useState } from "react";
import { type Me } from "../ui";

// Referral screen (ported from app design). The invite link uses the user's REAL referralCode
// (P-11: inviter earns 20% of the invitee's swipe+login points forever, once the invitee makes
// 10 swipes). Stats + recent invites are placeholders until a /api/referrals endpoint exists.
export function InviteScreen({ me }: { me: Me | null }) {
  const [copied, setCopied] = useState(false);
  const link = me ? `hedge.fun/r/${me.user.referralCode.slice(0, 8)}` : "hedge.fun/r/…";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`https://${link}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked (insecure context) — no-op */
    }
  };

  return (
    <div className="hf-scroll" style={{ position: "absolute", inset: 0, overflowY: "auto", padding: "8px 18px 20px", textAlign: "center" }}>
      <div style={{ fontSize: 56, marginTop: 10 }}>🤝</div>
      <div style={{ fontFamily: "var(--df)", fontSize: 34, lineHeight: 1, marginTop: 6 }}>Farm faster<br />with friends</div>
      <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 8, maxWidth: 280, marginLeft: "auto", marginRight: "auto", textWrap: "pretty" }}>
        You earn 20% of every friend&apos;s points — forever — once they make their first 10 calls.
      </div>

      <div style={{ marginTop: 22, background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 16, padding: "6px 6px 6px 16px", display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ flex: 1, textAlign: "left", fontFamily: "var(--nf)", fontSize: 13, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{link}</div>
        <div onClick={copy} style={{ background: "var(--energy)", color: "#fff", fontWeight: 700, padding: "11px 18px", borderRadius: 12, cursor: "pointer", fontSize: 13 }}>{copied ? "Copied!" : "Copy"}</div>
      </div>

      {/* ponytail: share buttons + invite history are placeholders — no /api/referrals yet (TODO). */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 9, marginTop: 12, opacity: 0.5 }}>
        {["𝕏 Share", "✈ Telegram", "⧉ More"].map((t) => (
          <div key={t} style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 14, padding: "13px 6px", fontSize: 12, fontWeight: 700 }}>{t}</div>
        ))}
      </div>

      <div style={{ marginTop: 22, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 18, padding: 16 }}>
          <div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 26, color: "var(--energy)" }}>—</div>
          <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".1em", marginTop: 2 }}>Friends joined</div>
        </div>
        <div style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 18, padding: 16 }}>
          <div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 26, color: "var(--gold)" }}>—</div>
          <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".1em", marginTop: 2 }}>Points earned</div>
        </div>
      </div>
    </div>
  );
}
