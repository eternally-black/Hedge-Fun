import { NextResponse, type NextRequest } from "next/server";

// Stealth referral capture. A visitor clicks /r/<code>; we set the hf_ref cookie and redirect to
// a CLEAN "/" — no /r/ and no ?ref= ever shows in the address bar, so the invitee just sees
// app.hedgeyour.fun while already being marked. The client (page.tsx) reads the code from the
// cookie, logs the click to /api/ref-click, and forwards it to /api/login-mark on first auth.
//
// Edge runtime: NO Prisma, NO server-to-self fetch (unreliable in self-hosted standalone) — this
// only sets the cookie and redirects. All hashing/DB work is client-triggered → Node routes.

const REF_COOKIE = "hf_ref";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

// Codes are 4 chars from the no-look-alike alphabet (refcode.ts). Accept 3..8 to stay tolerant
// if CODE_LEN ever bumps, but reject anything that isn't a plausible code (don't redirect junk).
const CODE_RE = /^[A-HJ-NP-Z2-9]{3,8}$/i;

export function middleware(req: NextRequest) {
  const code = req.nextUrl.pathname.slice("/r/".length);

  // Clean redirect to root. Strip any query too — the address bar ends up bare.
  const dest = new URL("/", req.url);
  const res = NextResponse.redirect(dest);

  if (!CODE_RE.test(code)) return res; // malformed -> still bounce to /, just don't mark

  // Mark the device. Not httpOnly: the client reads it to forward on login-mark. lax is enough —
  // this isn't a session token, just an attribution hint.
  res.cookies.set({
    name: REF_COOKIE,
    value: code,
    httpOnly: false,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: COOKIE_MAX_AGE,
    path: "/",
  });

  // NOTE: the click is logged from the CLIENT (page.tsx reads the hf_ref cookie on load and POSTs
  // to /api/ref-click), NOT from here. A server-to-self fetch from self-hosted Next middleware is
  // unreliable (no waitUntil; fetch to req.url's host doesn't round-trip in standalone behind a
  // proxy) — verified dead in prod 2026-06-25. The browser fetch is rock-solid and hashes the same
  // visitor (its real IP/UA reach the route). Middleware's only jobs: set the cookie + clean redirect.
  return res;
}

// Only run on /r/* — keep the middleware off every other request.
export const config = { matcher: "/r/:code*" };
