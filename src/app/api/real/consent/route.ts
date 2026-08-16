// POST /api/real/consent — the durable per-user opt-in (§2.7 inner gate; owner decision, S8).
// DELETE /api/real/consent — revocation: closes every real route via hasRealConsent.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUserStrict } from "@/lib/privy";
import { isRealMoneyEligible, sameOrigin } from "@/lib/real";
import { REAL_TERMS_VERSION } from "@/lib/real-terms";

export async function POST(req: Request) {
  const auth = await authUserStrict(req);
  if ("error" in auth) {
    return auth.error === "unauthorized"
      ? NextResponse.json({ error: "unauthorized" }, { status: 401 })
      : NextResponse.json({ error: "auth_unavailable" }, { status: 503 });
  }
  const user = auth.user;

  if (!isRealMoneyEligible(user)) return NextResponse.json({ error: "real_disabled" }, { status: 403 });
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const { accept, version } = body as { accept?: unknown; version?: unknown };
  if (accept !== true) return NextResponse.json({ error: "accept_required" }, { status: 400 });
  // The client must name the version it actually rendered. Accepting without it — or naming a stale
  // one after the text changed — is not consent to THIS text, and recording it as such is exactly
  // what the version column exists to prevent. The client re-reads the terms and asks again.
  if (version !== REAL_TERMS_VERSION) {
    return NextResponse.json({ error: "terms_version_mismatch", version: REAL_TERMS_VERSION }, { status: 409 });
  }

  // Idempotent for the SAME version: the first acceptance of the current text keeps its moment. A
  // user who accepted an OLDER version does not match this WHERE, so they get a fresh timestamp for
  // what they have now agreed to — a re-consent, not a silent carry-over.
  //
  // The null arm is NOT redundant. `NOT (realConsentVersion = 'x')` is NULL — not true — for a row
  // where the column IS NULL, which is every user who has never consented. Without it updateMany
  // matched zero rows, consent silently never persisted, and the very next call to /api/real/mode
  // answered 403 consent_required: the switch looked broken with no error anywhere on screen.
  await prisma.user.updateMany({
    where: {
      id: user.id,
      OR: [{ realConsentVersion: null }, { NOT: { realConsentVersion: REAL_TERMS_VERSION } }],
    },
    data: { realConsentAt: new Date(), realConsentVersion: REAL_TERMS_VERSION },
  });

  const updated = await prisma.user.findUnique({
    where: { id: user.id },
    select: { realConsentAt: true, realConsentVersion: true },
  });
  return NextResponse.json({
    consentAt: updated?.realConsentAt?.toISOString() ?? null,
    version: updated?.realConsentVersion ?? null,
  });
}

export async function DELETE(req: Request) {
  const auth = await authUserStrict(req);
  if ("error" in auth) {
    return auth.error === "unauthorized"
      ? NextResponse.json({ error: "unauthorized" }, { status: 401 })
      : NextResponse.json({ error: "auth_unavailable" }, { status: 503 });
  }
  const user = auth.user;

  if (!isRealMoneyEligible(user)) return NextResponse.json({ error: "real_disabled" }, { status: 403 });
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });

  // Revoking clears the version AND drops the user out of real mode: leaving realMode true with
  // consent gone renders a real-money shell whose every action 403s.
  await prisma.user.update({
    where: { id: user.id },
    data: { realConsentAt: null, realConsentVersion: null, realMode: false },
  });
  return NextResponse.json({ consentAt: null, version: null });
}
