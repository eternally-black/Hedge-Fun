"use client";

import { useState } from "react";
import { type Me } from "../ui";
import { INVITE_X, INVITE_TG, SHARE_BASE_URL, composeXShare, composeTgShare, openShare } from "@/lib/share";

// Referral screen (ported from app design). The invite link uses the user's REAL referralCode
// (P-11: inviter earns 20% of the invitee's swipe+login points forever, once the invitee makes
// 10 swipes). Stats + recent invites are placeholders until a /api/referrals endpoint exists.
export function InviteScreen({ me }: { me: Me | null }) {
  const [copied, setCopied] = useState(false);
  const code = me?.user.referralCode ?? null;
  // Display strips the scheme; the real link carries the FULL code as ?ref= (login-mark captures it).
  const link = code ? `${SHARE_BASE_URL.replace(/^https?:\/\//, "")}/?ref=${code}` : "…";

  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(`${SHARE_BASE_URL}/?ref=${code}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked (insecure context) — no-op */
    }
  };

  // Roll a fresh random line each tap (compose*Share picks internally) and open the composer.
  // openShare is the platform-specific opener (web here; native lands in the Expo app later).

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

      {/* Share to X / Telegram. Each tap rolls a random copy line and opens the composer
          (X: post intent; Telegram: share-to-chat) — unauthenticated web intent, no OAuth.
          Copy-link lives on the link row above, so no third button here. */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9, marginTop: 12 }}>
        <ShareBtn label="𝕏 Share" disabled={!code} onClick={() => code && openShare(composeXShare(INVITE_X, code))} />
        <ShareBtn label="✈ Telegram" disabled={!code} onClick={() => code && openShare(composeTgShare(INVITE_TG, code))} />
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

function ShareBtn({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 14,
        padding: "13px 6px", fontSize: 12, fontWeight: 700, color: "var(--text)",
        cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1, font: "inherit",
      }}
    >
      {label}
    </button>
  );
}
