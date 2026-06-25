# Share invites — web now, Android next

How invite/win sharing works today (web) and exactly what the Android (Expo/React Native)
session needs to add. Goal: the Android work is "drop in an opener + a deep-link capture
service", not "rebuild sharing". Code: [`src/lib/share.ts`](../src/lib/share.ts).

---

## 1. Decision: web intents, not OAuth (and why)

Share buttons open the X/Telegram **composer prefilled** and the user taps Post/Send. These are
unauthenticated **web intents** — plain links. They need **no OAuth** (not 1.0a, not 2.0).

OAuth + the X API is a *different mechanism*: it lets our server post **on the user's behalf,
programmatically**. We deliberately do NOT use it for sharing:

| | Web intent (chosen) | OAuth + X API (rejected for sharing) |
|---|---|---|
| Who posts | The user, consciously | Our code, automatically |
| Cost | Free | Paid X API tier + developer review |
| UX | User sees & edits the post | Auto-post → reads as spam |
| Tokens | None | Must store/rotate/revoke write tokens (attack surface) |
| Telegram analog | `t.me/share/url` | None — TG has no "post as user" API for personal accounts |

OAuth is only the right tool if we ever want **auto-posting without the user acting** (e.g. every
win auto-tweets). That is a product decision with real downsides (spam perception) — discuss with
the client alongside the deferred win-share, not a sharing-mechanism upgrade.

Note: X **login** already goes through OAuth, via Privy (see memory `hedgefun-x-auth`). That's
identity, not sharing. If we ever need to *read* a user's X data, route it through Privy — don't
stand up a second OAuth.

---

## 2. Is a web intent enough for Android? No — it degrades.

In the **web app**, `window.open('https://x.com/intent/post?...')` works: the browser opens X/TG,
the user is logged in, posts. Fine.

In a **native Expo/RN app** the same `https://...` intent is a *worst-effort* path:

- `window.open` doesn't exist in RN — must use `Linking.openURL`.
- `https://x.com/intent/post` is a **web page**. With the X app installed, Android *may* route it
  to the native app via App Links — but only if X declared that intent-filter (not our call). If
  it doesn't catch, it opens web-X in a Custom Tab, where a known bug shows the **X login screen
  instead of the composer** (the Custom Tab doesn't share the native app's session).
- Telegram is more reliable via its native scheme `tg://msg_url`.

So: native still *works*, but "tap → prefilled composer" isn't guaranteed. The fix is a native
opener with deep-link-first + fallbacks (below), not OAuth.

---

## 3. The platform split (already in code)

`share.ts` is **platform-independent** and must stay so — RN imports it verbatim. The split is
*only* in how the result is opened.

- **Copy sets** (`INVITE_X`, `INVITE_TG`, `WIN_X`, `WIN_TG`), the random `pick`, and
  `composeXShare` / `composeTgShare` are pure string-builders. Identical on web and native.
- `compose*Share` returns a **`ShareIntent`** carrying every form a platform might open:

  ```ts
  interface ShareIntent {
    channel: "x" | "telegram";
    text: string;     // full message + link (+ @handle for X) — the universal Share-sheet fallback
    url: string;      // bare invite link, https://app.hedgeyour.fun/?ref=CODE
    webUrl: string;   // web intent — window.open (web)
    nativeUrl: string;// app deep-link: twitter://post / tg://msg_url (RN Linking)
  }
  ```

- **Openers** are the only platform-specific bit. Web's lives in `share.ts` (`openShare`). Native's
  lives in the RN app (don't import `Linking`/`window` into `share.ts` — keep it env-free).

### Native opener to implement (Android session)

```ts
// In the Expo app — NOT in share.ts (keeps share.ts importable from RN unchanged).
import { Linking, Share } from "react-native";
import type { ShareIntent } from "@/lib/share";

export async function openShareNative(intent: ShareIntent) {
  // 1. Try the native app deep-link (best UX: lands in the real composer).
  try {
    if (await Linking.canOpenURL(intent.nativeUrl)) {
      return await Linking.openURL(intent.nativeUrl);
    }
  } catch { /* fall through */ }
  // 2. App not installed / scheme refused → web intent in a Custom Tab.
  try {
    return await Linking.openURL(intent.webUrl);
  } catch { /* fall through */ }
  // 3. Last resort → OS Share-sheet. Always works; user picks any app. text has the link inline.
  return Share.share({ message: intent.text });
}
```

`react-native` `Linking` + `Share` are built-in — no new dependency. `canOpenURL` for custom
schemes (`twitter://`, `tg://`) needs them listed in the Android manifest `<queries>` (Expo:
`expo.android.intentFilters` / a config-plugin) — note this when wiring.

The call site stays the same shape as web: `onClick={() => openShareNative(composeXShare(INVITE_X, code))}`.

---

## 4. Deferred `?ref=` capture on Android (deep-dive — needs a decision)

**The problem.** On web, the invite link is `https://app.hedgeyour.fun/?ref=CODE`; the client reads
`?ref=` and forwards it to `/api/login-mark` (see `src/app/page.tsx`, sessionStorage `hf_ref`).
That works because the browser lands directly on our URL with the query intact.

On Android the friend usually **doesn't have the app yet**. The flow is:
tap invite link → Play Store → install → first open. The `?ref=CODE` query **does not survive** that
trip — a fresh install has no idea what link triggered it. This is the classic *deferred deep link*
problem. Without solving it, Android installs attribute **zero** referrals.

**The options** (pick one — this is the open decision):

| Option | How it carries the code install→open | Cost / lock-in | Notes |
|---|---|---|---|
| **Play Install Referrer API** | Google passes the Play Store `referrer` string (we put `CODE` in the store link's `&referrer=`) to the app on first launch | Free, Google-native, Android-only | Needs the `play-install-referrer` lib + reading it once on first open. iOS later needs its own thing. Most self-contained. |
| **Branch.io / similar** | Their SDK fingerprints the click and hands the code to the app post-install, cross-platform | Free tier, but a 3rd-party SDK + dependency | Handles iOS too, nicer link UX (one link routes web/iOS/Android). Heavier; data leaves to a vendor. |
| **Manual code entry** | Friend pastes/﻿types the code in onboarding | Free, zero infra | Ugly UX, big drop-off. Fine as a stopgap / fallback only. |

**Recommendation to discuss:** if Android is the only near-term native target, **Play Install
Referrer** is the lazy correct choice — Google-native, free, no vendor. Add Branch only when iOS
lands and a single cross-platform link becomes worth a dependency. Keep manual entry as a fallback
field regardless (covers the "referrer got lost" tail).

**Server side is already ready** either way: capture is just "call `/api/login-mark?ref=CODE` once,
authenticated". `captureReferral` is idempotent (unique `inviteeId`). Whatever delivers the code to
the app, the app does the same POST the web client does today — no backend change needed.

**Store-link prep (do when we build the Android store listing):** the invite link the app *shares*
should, on Android, point at a Play Store URL with `&referrer=CODE` (or a Branch link) instead of
the bare web URL — so `composeXShare`/`composeTgShare` will need an Android-aware `refLink`. That's a
small change to one function; the copy sets don't move.

---

## 5. Win-share (also deferred)

`WIN_X` / `WIN_TG` copy is written and tested but **not wired to any button** — there's no win-share
UI surface yet. Deferred pending a product conversation with the client (when/where it fires). When
it ships, it reuses `composeXShare(WIN_X, code)` + the same opener. One import away.

---

## Checklist for the Android session

- [ ] Add `openShareNative` (section 3) in the Expo app; reuse `share.ts` unchanged.
- [ ] Manifest `<queries>` for `twitter://`, `tg://` so `canOpenURL` works.
- [ ] Pick a deferred-deep-link option (section 4); wire first-open `?ref` capture → `login-mark`.
- [ ] Make `refLink` Android-aware (store link + `referrer=CODE`) once the store listing exists.
- [ ] (When the client signs off) wire win-share to `composeXShare(WIN_X, …)`.
