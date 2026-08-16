// POST /api/real/mode — flip the profile's Paper/Real switch. Body: { real: boolean }.
//
// This decides what the app RENDERS, never what it may spend. Every money route re-derives its own
// authority from consent + same-origin on each call, so a forged flip here buys an attacker a
// real-money-looking shell whose every action still 403s. Kept as its own route rather than folded
// into /api/real/consent because they answer different questions: consent is "may I", mode is
// "am I looking at it", and a user who consented once should be able to move between the two
// economies without re-accepting anything.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUserStrict } from "@/lib/privy";
import { hasRealConsent, sameOrigin } from "@/lib/real";
import { REAL_TERMS_VERSION } from "@/lib/real-terms";

export async function POST(req: Request) {
  const auth = await authUserStrict(req);
  if ("error" in auth) {
    return auth.error === "unauthorized"
      ? NextResponse.json({ error: "unauthorized" }, { status: 401 })
      : NextResponse.json({ error: "auth_unavailable" }, { status: 503 });
  }
  const user = auth.user;
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const { real } = body as { real?: unknown };
  if (typeof real !== "boolean") return NextResponse.json({ error: "bad_request" }, { status: 400 });

  // Turning it ON needs consent to the CURRENT text. Turning it OFF is always allowed and never
  // gated: whatever state the account is in, getting back to play money must not be blocked — a
  // user who cannot leave real mode is the one failure here with no acceptable version.
  if (real) {
    if (!hasRealConsent(user)) {
      return NextResponse.json({ error: "consent_required", termsVersion: REAL_TERMS_VERSION }, { status: 403 });
    }
    if (user.realConsentVersion !== REAL_TERMS_VERSION) {
      return NextResponse.json(
        { error: "terms_version_mismatch", termsVersion: REAL_TERMS_VERSION },
        { status: 409 },
      );
    }
  }

  await prisma.user.update({ where: { id: user.id }, data: { realMode: real } });
  return NextResponse.json({ mode: real ? "REAL" : "PAPER" });
}
