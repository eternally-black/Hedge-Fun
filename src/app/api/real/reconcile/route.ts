// POST /api/real/reconcile — the SERVER side of order reconciliation (plan §2.1 step 6 +
// pre-Gate-0 item 4). The poller is SDK-free by design, so it POSTs here on a slow cadence and
// this route supplies the SDK-backed probes (src/lib/order-probe.ts). Trust boundary: this is
// machine-to-machine, NOT a user session — a shared secret gates it, and with no secret set the
// route refuses to run at all rather than reconcile unauthenticated.
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { reconcileStuckAttempts, discoverOrphanAttempts } from "@/lib/reconcile";
import { captureToGlitchTip } from "@/lib/glitchtip";
import { realProbes } from "@/lib/order-probe";

export async function POST(req: Request) {
  const secret = process.env.REAL_RECONCILE_SECRET;
  if (!secret) return NextResponse.json({ error: "reconcile_not_configured" }, { status: 503 });
  // timingSafeEqual throws on mismatched lengths — compare lengths first.
  const provided = Buffer.from(req.headers.get("x-reconcile-secret") ?? "");
  const expected = Buffer.from(secret);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { limit?: unknown; minAgeMs?: unknown };
  const limit = typeof body.limit === "number" ? Math.min(50, Math.max(1, Math.round(body.limit))) : undefined;
  const minAgeMs = typeof body.minAgeMs === "number" ? Math.max(60_000, Math.round(body.minAgeMs)) : undefined;

  const { probe, discover } = realProbes(prisma);

  try {
    const counts = await reconcileStuckAttempts(prisma, probe, { limit, minAgeMs });

    // Second sweep, and the one that keeps browser-posting honest: an attempt stuck in SUBMITTING
    // with NO externalOrderId is a browser that posted and died before reporting the id. Every
    // reconcile scan filters on that column being non-null, so the row is invisible to the sweep
    // above and the partial unique index wedges that market for that user forever. Discovery asks
    // the exchange whether the order exists, then adopts it (and books it) or kills the attempt
    // and hands the slot back. Its own try/catch: a discovery failure must not sink the pass that
    // resolves already-identified orders.
    let orphans = { unknown: 0, adopted: 0, killed: 0, scanned: 0 };
    try {
      orphans = await discoverOrphanAttempts(prisma, discover, probe, { limit, minAgeMs });
    } catch (e) {
      await captureToGlitchTip(e, { route: "real/reconcile", stage: "orphan-sweep" });
    }

    return NextResponse.json({ ...counts, orphans });
  } catch (e) {
    await captureToGlitchTip(e, { route: "real/reconcile" });
    return NextResponse.json({ error: "reconcile_failed" }, { status: 500 });
  }
}
