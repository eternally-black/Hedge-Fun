"use client";

import { useCallback, useMemo, useState } from "react";
import { type Me, type Card, countdown } from "../ui";
import { SKINS, skinById } from "@/lib/skins";
import { skinStyle } from "../skins";
import { CardFace } from "../DeckCard";
import { STAKE_CENTS } from "@/lib/config";

type Api = (path: string, init?: RequestInit) => Promise<unknown>;

// The Vault (ported from app design): shard→artifact progress ring, artifacts owned, and the Card
// Designs shop. (Streak recovery lives on the GM screen now — spend an artifact there.) The shop
// spends artifacts on cosmetic card skins via /api/skins; tapping a tile opens a
// preview-before-spend overlay on the user's real next card.
export function VaultScreen({
  me,
  api,
  onRefresh,
  previewCard,
}: {
  me: Me | null;
  api: Api;
  onRefresh: () => Promise<void>;
  previewCard?: Card;
}) {
  const [busy, setBusy] = useState(false);
  const [previewSkin, setPreviewSkin] = useState<string | null>(null);
  // One frozen "now" for the preview (lazy init = pure). A preview card doesn't need a live tick.
  const [nowMs] = useState(() => Date.now());
  const shards = me?.shards ?? 0;
  const per = me?.shardsPerArtifact ?? 20;
  const artifacts = me?.artifacts ?? 0;
  const owned = me?.skins.owned ?? ["classic"];
  const equipped = me?.skins.equipped ?? "classic";
  const circumference = 326.7;
  const dash = `${((shards / per) * circumference).toFixed(0)} ${circumference}`;

  // Unlock spends artifacts (then equips); equip just switches. Both POST /api/skins, then refresh
  // /api/me so balances + the live deck repaint, and close the preview. Stable callback (api/onRefresh).
  const act = useCallback(
    async (action: "unlock" | "equip", skinId: string) => {
      setBusy(true);
      try {
        await api("/api/skins", { method: "POST", body: JSON.stringify({ action, skinId }) });
        await onRefresh();
        setPreviewSkin(null);
      } catch (e) {
        console.error(e);
      } finally {
        setBusy(false);
      }
    },
    [api, onRefresh],
  );

  // The card the preview renders the skin on: the user's real next deck card when available, else a
  // representative sample. Memoized so its identity is stable (CardFace is memo'd on `card`).
  const previewBase = useMemo<Card>(
    () =>
      previewCard ?? {
        id: "sample",
        question: "Will Bitcoin close above $80,000 this week?",
        category: null,
        outcomeYesLabel: "Yes",
        outcomeNoLabel: "No",
        yesPriceBp: 5200,
        noPriceBp: 4800,
        resolutionDeadline: new Date(nowMs + 4 * 3_600_000).toISOString(),
      },
    [previewCard, nowMs],
  );

  return (
    <>
      <div className="hf-scroll" style={{ position: "absolute", inset: 0, overflowY: "auto", padding: "8px 18px 20px", textAlign: "center" }}>
        <div style={{ fontFamily: "var(--df)", fontSize: 30, marginTop: 6 }}>The Vault</div>
        <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>Correct calls drop shards. {per} shards forge 1 artifact.</div>

        <div style={{ margin: "20px auto 0", width: 150, height: 150, position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg viewBox="0 0 120 120" style={{ position: "absolute", inset: 0, transform: "rotate(-90deg)" }}>
            <circle cx="60" cy="60" r="52" fill="none" stroke="var(--panel2)" strokeWidth="10" />
            <circle cx="60" cy="60" r="52" fill="none" stroke="var(--gold)" strokeWidth="10" strokeLinecap="round" strokeDasharray={dash} />
          </svg>
          <div style={{ position: "relative" }}>
            <div style={{ fontSize: 40, filter: "drop-shadow(0 0 12px var(--gold))" }}>◆</div>
            <div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 20, color: "var(--gold)", marginTop: 2 }}>{shards}/{per}</div>
          </div>
        </div>
        <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 6 }}>{per - shards} more shards to forge your next artifact</div>

        <div style={{ marginTop: 22, textAlign: "left", fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--muted)", fontWeight: 700 }}>Artifacts</div>
        <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
          {Array.from({ length: 3 }).map((_, i) => {
            const isOwned = i < artifacts;
            return (
              <div key={i} style={{ flex: 1, aspectRatio: "1", borderRadius: 18, background: isOwned ? "linear-gradient(150deg,color-mix(in srgb,var(--gold) 30%,var(--panel)),var(--panel))" : "var(--panel)", border: isOwned ? "1px solid color-mix(in srgb,var(--gold) 40%,var(--line))" : "1px dashed var(--line)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, opacity: isOwned ? 1 : 0.5, animation: isOwned ? "hfPulse 2.4s ease-in-out infinite" : "none" }}>
                <div style={{ fontSize: 30 }}>{isOwned ? "🛡" : "＋"}</div>
                <div style={{ fontSize: 10, color: isOwned ? "var(--gold)" : "var(--muted)", fontWeight: 700 }}>{isOwned ? "Artifact" : "Locked"}</div>
              </div>
            );
          })}
        </div>

        {/* Card Designs shop — spend artifacts on deck looks (README §5). Lives inside the Vault. */}
        <div style={{ marginTop: 26, textAlign: "left" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: "var(--df)", fontSize: 22, lineHeight: 1 }}>Card Designs</div>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>Spend artifacts on new deck looks. Tap to preview before you buy.</div>
            </div>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "color-mix(in srgb,var(--gold) 14%,var(--panel))", border: "1px solid color-mix(in srgb,var(--gold) 40%,var(--line))", padding: "7px 12px", borderRadius: 22 }}>
              <span style={{ fontSize: 14 }}>🛡</span>
              <span style={{ fontFamily: "var(--nf)", fontWeight: 700, color: "var(--gold)", fontSize: 15 }}>{artifacts}</span>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 11, marginTop: 13 }}>
            {SKINS.map((sk) => {
              const look = skinStyle(sk.id, sk.accent, false);
              const isEquipped = equipped === sk.id;
              const isOwned = owned.includes(sk.id);
              const affordable = artifacts >= sk.cost;
              const badge = isEquipped ? "Equipped" : isOwned ? "Owned" : `🛡 ${sk.cost}`;
              const badgeBg = isEquipped ? "var(--yes)" : !isOwned && affordable ? "var(--gold)" : "rgba(0,0,0,.5)";
              const badgeColor = isEquipped ? "#04210f" : !isOwned && affordable ? "#1a1205" : "#fff";
              const tileBd = isEquipped ? "color-mix(in srgb,var(--yes) 55%,transparent)" : "var(--line)";
              return (
                <button key={sk.id} type="button" onClick={() => setPreviewSkin(sk.id)} style={{ font: "inherit", color: "var(--text)", padding: 0, borderRadius: 16, overflow: "hidden", border: `1.5px solid ${tileBd}`, background: "var(--panel)", cursor: "pointer", textAlign: "left" }}>
                  <div style={{ position: "relative", height: 116, background: look.bg }}>
                    {look.overlay ? <div style={{ position: "absolute", inset: 0, opacity: 0.85, pointerEvents: "none" }}>{look.overlay}</div> : null}
                    <div style={{ position: "absolute", top: 8, right: 8, background: badgeBg, color: badgeColor, fontFamily: "var(--nf)", fontWeight: 700, fontSize: 11, padding: "3px 9px", borderRadius: 20, backdropFilter: "blur(3px)" }}>{badge}</div>
                  </div>
                  <div style={{ padding: "10px 11px 12px" }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{sk.name}</div>
                    <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2, lineHeight: 1.3 }}>{sk.blurb}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {previewSkin ? (
        <PreviewOverlay
          skinId={previewSkin}
          card={previewBase}
          owned={owned}
          equipped={equipped}
          artifacts={artifacts}
          per={per}
          busy={busy}
          nowMs={nowMs}
          onClose={() => setPreviewSkin(null)}
          onUnlock={() => act("unlock", previewSkin)}
          onEquip={() => act("equip", previewSkin)}
        />
      ) : null}
    </>
  );
}

// Preview-before-spend overlay: renders the selected skin on a real card stamped PREVIEW, with a
// state-driven CTA (Unlock / Equip / Equipped / Need more artifacts). Preview itself is always free.
function PreviewOverlay({
  skinId,
  card,
  owned,
  equipped,
  artifacts,
  per,
  busy,
  nowMs,
  onClose,
  onUnlock,
  onEquip,
}: {
  skinId: string;
  card: Card;
  owned: string[];
  equipped: string;
  artifacts: number;
  per: number;
  busy: boolean;
  nowMs: number;
  onClose: () => void;
  onUnlock: () => void;
  onEquip: () => void;
}) {
  const sk = skinById(skinId);
  const cd = countdown(card.resolutionDeadline, nowMs);
  if (!sk) return null;

  const isEquipped = equipped === sk.id;
  const isOwned = owned.includes(sk.id);
  const affordable = artifacts >= sk.cost;

  let label: string, bg: string, fg: string, hint: string;
  let onCta: (() => void) | undefined;
  if (isEquipped) {
    label = "Equipped ✓"; bg = "var(--panel2)"; fg = "var(--muted)"; hint = "This design is live on your deck.";
  } else if (isOwned) {
    label = "Equip design"; bg = "var(--energy)"; fg = "#fff"; hint = "You own this design — make it active."; onCta = onEquip;
  } else if (affordable) {
    label = `Unlock for 🛡 ${sk.cost}`; bg = "var(--gold)"; fg = "#1a1205"; hint = `Spends ${sk.cost} of your ${artifacts} artifacts · equips instantly.`; onCta = onUnlock;
  } else {
    label = `Need 🛡 ${sk.cost}`; bg = "var(--panel2)"; fg = "var(--muted)"; hint = `You have ${artifacts}. Forge ${per} shards to mint an artifact.`;
  }
  const disabled = busy || !onCta;

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 60, background: "rgba(4,4,8,.74)", backdropFilter: "blur(10px)", display: "flex", flexDirection: "column", animation: "hfRise .26s ease" }}>
      <div style={{ display: "flex", alignItems: "center", padding: "18px 18px 4px" }}>
        <div style={{ fontSize: 10, letterSpacing: ".22em", textTransform: "uppercase", color: "var(--muted)", fontWeight: 700 }}>Preview design</div>
        <button type="button" onClick={onClose} style={{ marginLeft: "auto", width: 34, height: 34, borderRadius: "50%", background: "var(--panel)", border: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontSize: 14, color: "var(--text)" }}>✕</button>
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "4px 22px", minHeight: 0 }}>
        <div style={{ position: "relative", width: 262, maxWidth: "100%", aspectRatio: "0.62", borderRadius: 24, overflow: "hidden", border: "1px solid var(--line)", boxShadow: "0 26px 56px -18px rgba(0,0,0,.85)" }}>
          {/* A skin preview, not a live card: the paper stake is the right number to draw it with,
              and there is nothing here to edit — no onEditStake, so the chip stays inert. */}
          <CardFace card={card} skinId={sk.id} countdownText={cd.text} urgent={cd.urgent} windowText={cd.relText} yesP={0} noP={0} skipP={0} stakeCents={STAKE_CENTS} />
          <div style={{ position: "absolute", top: 12, left: 12, background: "var(--energy)", color: "#fff", fontFamily: "var(--df)", fontSize: 12, letterSpacing: ".06em", padding: "3px 10px", borderRadius: 8, transform: "rotate(-4deg)", boxShadow: "0 6px 16px -4px color-mix(in srgb,var(--energy) 60%,transparent)" }}>PREVIEW</div>
        </div>
        <div style={{ textAlign: "center", marginTop: 15 }}>
          <div style={{ fontFamily: "var(--df)", fontSize: 24 }}>{sk.name}</div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2, maxWidth: 280 }}>{sk.blurb}</div>
        </div>
      </div>
      <div style={{ padding: "4px 20px 20px" }}>
        <button type="button" onClick={disabled ? undefined : onCta} disabled={disabled} style={{ font: "inherit", border: "none", width: "100%", background: bg, color: fg, fontFamily: "var(--df)", fontSize: 21, textAlign: "center", padding: 15, borderRadius: 16, cursor: disabled ? "default" : "pointer" }}>{label}</button>
        <div style={{ textAlign: "center", marginTop: 9, fontSize: 11, color: "var(--muted)" }}>{hint}</div>
      </div>
    </div>
  );
}
