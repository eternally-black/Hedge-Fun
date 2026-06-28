"use client";

import { useState, type ReactNode } from "react";
import { num, type Me } from "../ui";
import { INVITE_X, INVITE_TG, refLink, composeXShare, composeTgShare, openShare } from "@/lib/share";

// Referral screen (ported from app design). The invite link uses the user's REAL referralCode
// (P-11: inviter earns 20% of the invitee's swipe+login points forever, once the invitee makes
// 10 swipes). Stats (friends joined, points earned) come live from /api/me (me.referrals).
export function InviteScreen({ me }: { me: Me | null }) {
  const [copied, setCopied] = useState(false);
  const code = me?.user.referralCode ?? null;
  // One source of truth for the invite URL (refLink → stealth /r/<code>). Display drops the scheme.
  const fullLink = code ? refLink(code) : null;
  const link = fullLink ? fullLink.replace(/^https?:\/\//, "") : "…";

  const copy = async () => {
    if (!fullLink) return;
    try {
      await navigator.clipboard.writeText(fullLink);
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
        <ShareBtn label={<><XIcon /> Share</>} disabled={!code} onClick={() => code && openShare(composeXShare(INVITE_X, code))} />
        <ShareBtn label={<><TelegramIcon /> Telegram</>} disabled={!code} onClick={() => code && openShare(composeTgShare(INVITE_TG, code))} />
      </div>

      <div style={{ marginTop: 22, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 18, padding: 16 }}>
          <div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 26, color: "var(--energy)" }}>{me ? num(me.referrals.joined) : "—"}</div>
          <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".1em", marginTop: 2 }}>Friends joined</div>
        </div>
        <div style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 18, padding: 16 }}>
          <div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 26, color: "var(--gold)" }}>{me ? num(me.referrals.pointsEarned) : "—"}</div>
          <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".1em", marginTop: 2 }}>Points earned</div>
        </div>
      </div>
    </div>
  );
}

function ShareBtn({ label, onClick, disabled }: { label: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 14,
        padding: "13px 6px", fontSize: 12, fontWeight: 700, color: "var(--text)",
        cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1, font: "inherit",
        display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
      }}
    >
      {label}
    </button>
  );
}

// Inline brand SVGs (currentColor, no icon-pack dependency). X = the rebrand mark (not the ×
// glyph); Telegram = the official paper-plane emblem. size matches the 12px button text.
function XIcon({ size = 13 }: { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function TelegramIcon({ size = 14 }: { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden>
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
  );
}
