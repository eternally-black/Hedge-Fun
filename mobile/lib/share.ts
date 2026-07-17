// COPIED from src/lib/share.ts — sync manually, do not diverge.
// NATIVE PORT: only the pure builders were copied (copy sets, pick, compose*Share, ShareIntent).
// `process.env` / `window` usage was stripped — the share base URL comes from app config
// (lib/config.ts). The web opener (openShare / buildXShare / buildTgShare) stays web-only; the
// native opener lives in lib/openShareNative.ts (see docs/share-and-android.md §3).
//
// Share-link copy + URL builders for X and Telegram.
//
// IMPORTANT: these are unauthenticated "web intent" links. They need NO OAuth (not 1.0a, not 2.0).
// A share button just opens X/TG's composer prefilled; the user taps "Post"/"Send" themselves.
//   X:  https://developer.x.com/en/docs/x-for-websites/tweet-button/guides/web-intent
//   TG: https://core.telegram.org/widgets/share
//
// Tone note: HedgeFun is a swipe-to-predict game. A "call" = one prediction swipe. Inviter
// earns 20% of a friend's points forever once the friend makes their first 10 calls.

import { SHARE_BASE_URL } from "./config";

export const X_HANDLE = "@hedgeyourfun"; // tag this in X copy. NOT in Telegram copy (no handles there).

// Public landing the link points at. Invite links use the STEALTH path /r/<code>: the middleware
// marks the visitor (hf_ref cookie + click log) and redirects to a clean "/" — so ?ref= never
// shows in the address bar. SHARE_BASE_URL comes from app config so a future Android build can
// point invite links at the Play Store URL (+ &referrer) without touching the copy sets — see
// docs/share-and-android.md §4 (TODO once the store listing exists).
export function refLink(referralCode: string): string {
  return `${SHARE_BASE_URL}/r/${encodeURIComponent(referralCode)}`;
}

// ---------------------------------------------------------------------------
// Copy sets. {ref} = the invite URL, {handle} = X_HANDLE (only present in X-tagged copy).
// Two channels need different copy: X copy tags the handle and writes for the timeline;
// Telegram copy is a DM/group message — no @handle (it wouldn't resolve there), warmer.
// ---------------------------------------------------------------------------

// --- REFERRAL INVITE — X (timeline post, tags the handle) ---
export const INVITE_X = [
  "Been calling markets on HedgeFun. Swipe yes/no, points stack, no money in. Join on my link and your first 10 calls back-pay me 20% — but you start with a bonus. {ref} {handle}",
  "HedgeFun is the most fun I've had being right about nothing. Predict, swipe, climb. Grab the bonus on my link: {ref} {handle}",
  "Found my new doomscroll: HedgeFun. It's a prediction game you actually win at. Use my link, get a head start: {ref} {handle}",
  "Think you read markets better than me? Settle it on HedgeFun. My link gives you a starting bonus: {ref} {handle}",
  "I swipe on real-world calls all day and somehow it's free. HedgeFun. Hop on my link: {ref} {handle}",
  "Calling it now: you'll get hooked. HedgeFun turns every market into a swipe. Bonus on signup with my link: {ref} {handle}",
] as const;

// --- REFERRAL INVITE — Telegram (DM/group, no handle) ---
export const INVITE_TG = [
  "Come play HedgeFun with me — you swipe yes/no on real-world calls and rack up points, no money in. Sign up on my link and you start with a bonus: {ref}",
  "Bet you can't out-predict me on HedgeFun. Free to play, weirdly addictive. My link gives you a head start: {ref}",
  "Pulling people into HedgeFun before it blows up. It's a prediction game you swipe through. Bonus on my link: {ref}",
  "You'd be good at this — HedgeFun, call markets by swiping, climb the board. Start with a bonus here: {ref}",
] as const;

// --- WIN / "NAILED THE CALL" — X (timeline post, tags the handle) ---
// ⚠️ NOT WIRED UP. Copy is ready; the win-share button is deferred to a later session
// (details to confirm with the client). Kept here so it's one import away when we ship it.
export const WIN_X = [
  "Called it. Nailed another one on HedgeFun while the timeline was still arguing about it. {ref} {handle}",
  "My read was right and I have the points to prove it. HedgeFun. {ref} {handle}",
  "Swiped yes, market agreed, I climbed. Another HedgeFun W. Think you'd have called it? {ref} {handle}",
  "Right again. HedgeFun keeps paying out for reading the room. Your turn: {ref} {handle}",
  "Green call on HedgeFun. Easy when you've been right all week. {ref} {handle}",
] as const;

// --- WIN — Telegram (no handle) — also deferred ---
export const WIN_TG = [
  "Just nailed another call on HedgeFun. Come lose to me — start with a bonus: {ref}",
  "Called this one right on HedgeFun. Think you'd have? Try it: {ref}",
  "Another W on HedgeFun. Free to play if you want to get cooked: {ref}",
] as const;

// ---------------------------------------------------------------------------
// Pick + fill. Random per call (each share opens a fresh roll).
// ---------------------------------------------------------------------------

// ponytail: Math.random() pick — fine for "feels varied". If we ever want the SAME user to
// always get the same line (stable previews / dedup), swap to a seeded FNV-1a like CallShot.
function pick<T>(set: readonly T[]): T {
  return set[Math.floor(Math.random() * set.length)]!;
}

// ---------------------------------------------------------------------------
// Channel builders. compose*Share is PLATFORM-INDEPENDENT: it returns a ShareIntent holding
// every form the result might need, so web and native each pick the field they can open.
// ---------------------------------------------------------------------------

export interface ShareIntent {
  channel: "x" | "telegram";
  /** Full message as plain text (copy + link [+ @handle for X]). The universal fallback —
   *  what the OS Share-sheet / "copy" path uses when no app-specific URL fires. */
  text: string;
  /** The bare invite URL (https://app.hedgeyour.fun/r/CODE). */
  url: string;
  /** Web intent URL — opened in a Custom Tab on native when the app deep-link is unavailable. */
  webUrl: string;
  /** Native app deep-link (twitter://post, tg://msg_url). Open with Linking.openURL on RN;
   *  if it fails (app not installed), fall back to webUrl in a Custom Tab, then to `text`
   *  via the OS Share-sheet. */
  nativeUrl: string;
}

// X: the whole post is one `text` blob — copy + @handle + link inline, as it reads on the
// timeline. {ref} -> the full invite URL, {handle} -> @hedgeyourfun.
export function composeXShare(set: readonly string[], referralCode: string): ShareIntent {
  const url = refLink(referralCode);
  const text = pick(set).replace("{ref}", url).replace("{handle}", X_HANDLE);
  return {
    channel: "x",
    text,
    url,
    // Modern endpoint is x.com/intent/post (twitter.com/intent/tweet redirects here).
    webUrl: `https://x.com/intent/post?text=${encodeURIComponent(text)}`,
    // Native X composer. `message` carries the full text (link inline), same as the web blob.
    nativeUrl: `twitter://post?message=${encodeURIComponent(text)}`,
  };
}

// Telegram: split text and url so TG renders a real link preview. The copy has no {handle}
// (handles don't resolve in TG) — we strip the " {ref}" tail and pass the URL as its own param.
export function composeTgShare(set: readonly string[], referralCode: string): ShareIntent {
  const url = refLink(referralCode);
  const msg = pick(set).replace(/\s*\{ref\}/, "").trim(); // message only; TG appends the url
  return {
    channel: "telegram",
    text: `${msg} ${url}`, // Share-sheet fallback needs the link IN the text.
    url,
    webUrl: `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(msg)}`,
    // Native Telegram share-sheet. Same url+text split as the web widget.
    nativeUrl: `tg://msg_url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(msg)}`,
  };
}
