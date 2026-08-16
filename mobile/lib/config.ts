// App config from EXPO_PUBLIC_* env (inlined by Expo at bundle time — see mobile/.env.example).
// EXPO_PUBLIC_* vars are readable via process.env in app code; they are baked in per build,
// never secret (that's the point of the PUBLIC prefix).

// Backend API base. All /api/* calls go here (Bearer-auth, same contract as the web client).
export const API_BASE = process.env.EXPO_PUBLIC_API_BASE ?? "https://app.hedgeyour.fun";

// Privy credentials. The Expo SDK requires BOTH an app id AND a mobile app client id
// (Privy dashboard → app clients). Web only needed the app id.
export const PRIVY_APP_ID = process.env.EXPO_PUBLIC_PRIVY_APP_ID ?? "";
export const PRIVY_CLIENT_ID = process.env.EXPO_PUBLIC_PRIVY_CLIENT_ID ?? "";

// Base for invite links (refLink in lib/share.ts). Points at the web app's stealth /r/<code>
// path today; once the Play Store listing exists this can become the store URL (+ &referrer).
export const SHARE_BASE_URL = process.env.EXPO_PUBLIC_SHARE_BASE_URL ?? "https://app.hedgeyour.fun";

// Deck freshness: a card with less time than this left before resolution never reaches the top
// (mirrors src/lib/config.ts DECK_MIN_LEAD_MS — the server enforces the same gate).
export const DECK_MIN_LEAD_MS = 5 * 60_000;

// How often the TOP card re-quotes its live executable price (mirrors src/lib/config.ts
// QUOTE_POLL_MS). Books churn every ~5s, so this keeps the payout the user is staring at honest
// while they deliberate. Only the top card polls; next-up cards are cold-rendered until they surface.
export const QUOTE_POLL_MS = 3_000;
