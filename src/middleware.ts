import { NextResponse, type NextRequest } from "next/server";

// Stealth referral capture. A visitor clicks /r/<code>; we set the hf_ref cookie and log the
// click, then redirect to a CLEAN "/" — no /r/ and no ?ref= ever shows in the address bar, so
// the invitee just sees app.hedgeyour.fun while already being marked. The client reads the code
// from the cookie (not the URL) and forwards it to /api/login-mark on first auth.
//
// Runs on the Edge runtime: NO Prisma here. Hashing + DB write happen in /api/ref-click (Node),
// which we fire-and-forget so it never delays the redirect.

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

  // Fire-and-forget click log (hashing + DB in the Node route). Never await — the redirect ships
  // immediately. A failed log just means no cross-browser fallback for this click.
  void fetch(new URL("/api/ref-click", req.url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Forward the real client signals so the route hashes the visitor, not the edge node.
      "x-forwarded-for": req.headers.get("x-forwarded-for") ?? "",
      "x-real-ip": req.headers.get("x-real-ip") ?? "",
      "user-agent": req.headers.get("user-agent") ?? "",
      "accept-language": req.headers.get("accept-language") ?? "",
    },
    body: JSON.stringify({ code }),
  }).catch(() => { /* best-effort */ });

  return res;
}

// Only run on /r/* — keep the middleware off every other request.
export const config = { matcher: "/r/:code*" };
