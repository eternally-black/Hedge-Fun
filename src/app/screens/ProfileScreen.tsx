"use client";

import { useEffect, useState } from "react";
import { useLinkAccount, usePrivy } from "@privy-io/react-auth";
import { type Me, num, usd } from "../ui";

type Api = (path: string, init?: RequestInit) => Promise<unknown>;

// Profile / "You" (ported from app design). Real stats from /api/me. Prediction history is a
// placeholder until /api/history. (No user-facing leaderboard — ranking is admin-only.)
export function ProfileScreen({ me, api, onRefresh, onHistory, onLogout }: { me: Me | null; api: Api; onRefresh: () => Promise<void>; onHistory: () => void; onLogout: () => void }) {
  const handle = me?.user.twitter ?? (me?.user.email ? me.user.email.split("@")[0] : "degen");
  const initials = handle.slice(0, 2).toUpperCase();
  const [resetting, setResetting] = useState(false);

  // X (Twitter) link/unlink. linkTwitter opens Privy's OAuth flow; on success we push the new handle
  // into our DB (/api/link/sync — extractIdentity only runs at first login) then refresh /api/me so
  // it renders. Unlink detaches in Privy client-side first, then /api/link/unlink nulls our column.
  const [busyX, setBusyX] = useState<null | "link" | "unlink">(null);
  const [xError, setXError] = useState<string | null>(null);
  const { user: privyUser, unlinkTwitter } = usePrivy();

  // Back-fill our DB from Privy's reconciled state. Single source of truth for "link succeeded" —
  // works for the OAuth *redirect* flow where useLinkAccount.onSuccess never fires (page remounts on
  // return), not just the popup flow. Idempotent: /api/link/sync no-ops once the handle is stored.
  const syncTwitter = async () => {
    try {
      await api("/api/link/sync", { method: "POST" });
      await onRefresh();
    } catch (e) {
      setXError(
        (e as { status?: number }).status === 409
          ? "That X account is already linked to another HedgeFun account — contact support."
          : "Couldn't link X. Try again.",
      );
    } finally {
      setBusyX(null);
    }
  };

  const { linkTwitter } = useLinkAccount({
    onSuccess: () => { setXError(null); void syncTwitter(); }, // popup flow; redirect flow → effect below
    onError: () => setBusyX(null),
  });

  // Redirect flow returns with Privy already linked but our DB null → back-fill once. Deps are
  // primitives; once the handle lands the condition flips false, so this can't loop.
  const privyTwitter = privyUser?.twitter?.username ?? null;
  useEffect(() => {
    // set-state-in-effect false positive: syncTwitter's setState calls are all post-await (async).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (privyTwitter && me && !me.user.twitter) void syncTwitter();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [privyTwitter, me?.user.twitter]);

  const startLink = () => {
    setXError(null);
    setBusyX("link");
    // Already linked in Privy but not synced (desync) → don't re-open OAuth (Privy throws "already
    // linked"); just back-fill our DB.
    if (privyUser?.twitter) { void syncTwitter(); return; }
    linkTwitter();
  };
  const startUnlink = async () => {
    setXError(null);
    setBusyX("unlink");
    try {
      // Unlink in Privy first (its subject id), then clear our DB. Privy requires ≥1 other account —
      // the email-signup user keeps their email, so this is allowed. No subject = nothing to unlink in
      // Privy; bail rather than clear our column (that would desync: gone here, still linked there).
      const subject = privyUser?.twitter?.subject;
      if (!subject) throw new Error("no twitter subject");
      await unlinkTwitter(subject);
      await api("/api/link/unlink", { method: "POST" });
      await onRefresh();
    } catch {
      setXError("Couldn't unlink X. Try again.");
    } finally {
      setBusyX(null);
    }
  };

  const resetDeck = async () => {
    setResetting(true);
    try {
      await api("/api/dev/reset-deck", { method: "POST" });
      await onRefresh();
    } catch (e) {
      console.error(e);
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="hf-scroll" style={{ position: "absolute", inset: 0, overflowY: "auto", padding: "4px 16px 20px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 6 }}>
        <div style={{ width: 58, height: 58, borderRadius: 18, background: "linear-gradient(140deg,var(--energy),color-mix(in srgb,var(--energy) 30%,#000))", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--df)", fontSize: 26, color: "#fff" }}>{initials}</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: "var(--df)", fontSize: 24, lineHeight: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{handle}</div>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>Test app · stack points</div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 16 }}>
        <Tile label="Points" value={me ? num(me.points.total) : "—"} color="var(--energy)" />
        <Tile label="Virtual $" value={me ? usd(me.balanceCents) : "—"} color="var(--yes)" />
        <Tile label="Streak" value={me ? `🔥 ${me.streak.level}d` : "—"} color="var(--text)" />
        <Tile label="◆ Shards" value={me ? `${me.shards}/${me.shardsPerArtifact}` : "—"} color="var(--gold)" />
      </div>

      <div style={{ marginTop: 20, fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--muted)", fontWeight: 700 }}>Prediction history</div>
      <div onClick={onHistory} style={{ marginTop: 10, background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 14, padding: 16, textAlign: "center", color: "var(--text)", fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
        <span>📜 View your open & settled predictions</span><span style={{ color: "var(--muted)" }}>›</span>
      </div>

      {me?.dev && (
        <div style={{ marginTop: 22, border: "1px dashed color-mix(in srgb,var(--skip) 50%,var(--line))", borderRadius: 14, padding: 14, background: "color-mix(in srgb,var(--skip) 8%,transparent)" }}>
          <div style={{ fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--skip)", fontWeight: 700 }}>Dev tools</div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>Unlimited skips are on. Reset re-deals every market.</div>
          <div onClick={resetting ? undefined : resetDeck} style={{ marginTop: 10, background: "var(--skip)", color: "#04121f", fontWeight: 700, fontSize: 13, textAlign: "center", padding: 12, borderRadius: 12, cursor: resetting ? "default" : "pointer", opacity: resetting ? 0.6 : 1 }}>
            {resetting ? "Resetting…" : "↻ Reset & reload deck"}
          </div>
        </div>
      )}

      {/* Account / sign out. Shows who's signed in (email or @handle) + a logout action. */}
      <div style={{ marginTop: 22, fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--muted)", fontWeight: 700 }}>Account</div>
      <div style={{ marginTop: 10, background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 14, padding: "12px 14px", display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 9, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)" }}>Signed in as</div>
          <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {me?.user.twitter ? `@${me.user.twitter}` : me?.user.email ?? "—"}
          </div>
        </div>
        <div onClick={onLogout} style={{ flexShrink: 0, background: "color-mix(in srgb,var(--no) 12%,var(--panel))", border: "1px solid color-mix(in srgb,var(--no) 40%,var(--line))", color: "var(--no)", fontWeight: 700, fontSize: 13, padding: "9px 16px", borderRadius: 12, cursor: "pointer" }}>
          Log out
        </div>
      </div>

      {/* X (Twitter) connection. Linked → show the @handle (+ Unlink for email-signup users; a
          twitter-signup user can't unlink — it's their login). Not linked → a Link button (email
          users only). */}
      <div style={{ marginTop: 10, background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 14, padding: "12px 14px", display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 9, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--muted)" }}>𝕏 Account</div>
          <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {me?.user.twitter ? `@${me.user.twitter}` : "Not connected"}
          </div>
        </div>
        {me?.user.twitter
          ? (me.user.authProvider === "EMAIL"
              ? <div onClick={busyX ? undefined : startUnlink} style={{ flexShrink: 0, background: "color-mix(in srgb,var(--no) 12%,var(--panel))", border: "1px solid color-mix(in srgb,var(--no) 40%,var(--line))", color: "var(--no)", fontWeight: 700, fontSize: 13, padding: "9px 16px", borderRadius: 12, cursor: busyX ? "default" : "pointer", opacity: busyX ? 0.6 : 1 }}>
                  {busyX === "unlink" ? "Unlinking…" : "Unlink"}
                </div>
              : null)
          : (me?.user.authProvider === "EMAIL"
              ? <div onClick={busyX ? undefined : startLink} style={{ flexShrink: 0, background: "color-mix(in srgb,var(--energy) 16%,var(--panel))", border: "1px solid color-mix(in srgb,var(--energy) 45%,var(--line))", color: "var(--energy)", fontWeight: 700, fontSize: 13, padding: "9px 16px", borderRadius: 12, cursor: busyX ? "default" : "pointer", opacity: busyX ? 0.6 : 1 }}>
                  {busyX === "link" ? "Linking…" : "Link 𝕏"}
                </div>
              : null)}
      </div>
      {xError ? <div style={{ marginTop: 8, fontSize: 12, color: "var(--no)" }}>{xError}</div> : null}
    </div>
  );
}

function Tile({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 18, padding: 14 }}>
      <div style={{ fontSize: 9, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--muted)" }}>{label}</div>
      <div style={{ fontFamily: "var(--nf)", fontWeight: 700, fontSize: 24, color, marginTop: 3 }}>{value}</div>
    </div>
  );
}
