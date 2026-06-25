// Self-checks for share-link builders (DB-free). Run: npx tsx scripts/test-share.ts
import assert from "node:assert";
import {
  INVITE_X, INVITE_TG, WIN_X, WIN_TG,
  X_HANDLE, SHARE_BASE_URL, refLink, buildXShare, buildTgShare,
  composeXShare, composeTgShare,
} from "../src/lib/share";

const CODE = "AbC-123_xyz"; // exercises url-safe chars that still encode (- and _ pass through)

// ---- ref link is the stealth /r/<code> path on the prod domain (middleware marks + redirects) ----
assert.strictEqual(refLink(CODE), `${SHARE_BASE_URL}/r/${CODE}`, "ref link = base/r/<code>");
assert.ok(SHARE_BASE_URL.startsWith("https://app.hedgeyour.fun"), "prod domain");

// ---- X share: full text blob, handle tagged, link inline, no leftover placeholders ----
const xi = composeXShare(INVITE_X, CODE);
const x = buildXShare(INVITE_X, CODE); // back-compat wrapper == .webUrl
assert.ok(x.startsWith("https://x.com/intent/post?text="), "modern x.com/intent/post endpoint");
assert.ok(xi.text.includes(X_HANDLE), "X copy tags @hedgeyourfun");
assert.ok(xi.text.includes(refLink(CODE)), "X copy embeds the full invite link");
assert.ok(!/\{ref\}|\{handle\}/.test(xi.text), "no unfilled placeholders in X copy");

// ---- TG share: handle MUST NOT appear; url split into its own param; text has no raw link ----
const ti = composeTgShare(INVITE_TG, CODE);
const tg = buildTgShare(INVITE_TG, CODE);
assert.ok(tg.startsWith("https://t.me/share/url?url="), "t.me/share/url endpoint");
assert.ok(tg.includes(`url=${encodeURIComponent(refLink(CODE))}`), "TG url param = invite link");
const tgMsg = decodeURIComponent(tg.split("&text=")[1]!);
assert.ok(!tgMsg.includes("@"), "TG copy never tags a handle");
assert.ok(!tgMsg.includes(refLink(CODE)), "TG web text omits the raw link (passed as url param)");
assert.ok(!/\{ref\}|\{handle\}/.test(tgMsg), "no unfilled placeholders in TG copy");

// ---- platform split: native deep-links present, Share-sheet text fallback carries the link ----
assert.ok(xi.nativeUrl.startsWith("twitter://post?message="), "X native deep-link = twitter://post");
assert.ok(ti.nativeUrl.startsWith("tg://msg_url?url="), "TG native deep-link = tg://msg_url");
assert.ok(xi.text.includes(refLink(CODE)), "X Share-sheet fallback text has the link inline");
assert.ok(ti.text.includes(refLink(CODE)), "TG Share-sheet fallback text has the link inline");
assert.ok(!ti.text.includes("@"), "TG fallback text still has no handle");
for (const i of [xi, ti]) {
  assert.ok(!/\{ref\}|\{handle\}/.test(i.nativeUrl), "no placeholders in native url");
  assert.ok(i.url === refLink(CODE), "bare url field = invite link");
}

// ---- no copy set tags a handle where it shouldn't; X sets must reference {handle}, TG must not ----
for (const t of [...INVITE_X, ...WIN_X]) assert.ok(t.includes("{handle}"), `X line missing {handle}: ${t}`);
for (const t of [...INVITE_TG, ...WIN_TG]) assert.ok(!t.includes("{handle}") && !t.includes("@"), `TG line has a handle: ${t}`);

// ---- every set is non-empty (pick() would throw otherwise) ----
for (const [name, set] of Object.entries({ INVITE_X, INVITE_TG, WIN_X, WIN_TG })) {
  assert.ok(set.length > 0, `${name} is empty`);
}

console.log("share self-checks passed ✓");
