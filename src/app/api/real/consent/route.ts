// POST /api/real/consent — the durable per-user opt-in (§2.7 inner gate; owner decision, S8).
// DELETE /api/real/consent — revocation: closes every real route via hasRealConsent.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authUserStrict } from "@/lib/privy";
import { isRealMoneyEligible, sameOrigin } from "@/lib/real";

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
  const { accept } = body as { accept?: unknown };
  if (accept !== true) return NextResponse.json({ error: "accept_required" }, { status: 400 });

  // Idempotent: the first consent moment is preserved; re-consenting never moves the timestamp.
  await prisma.user.updateMany({
    where: { id: user.id, realConsentAt: null },
    data: { realConsentAt: new Date() },
  });

  const updated = await prisma.user.findUnique({ where: { id: user.id }, select: { realConsentAt: true } });
  return NextResponse.json({ consentAt: updated?.realConsentAt?.toISOString() ?? null });
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

  await prisma.user.update({ where: { id: user.id }, data: { realConsentAt: null } });
  return NextResponse.json({ consentAt: null });
}
