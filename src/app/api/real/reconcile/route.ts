// POST /api/real/reconcile — the SERVER side of order reconciliation (plan §2.1 step 6 +
// pre-Gate-0 item 4). The poller is SDK-free by design, so it POSTs here on a slow cadence and
// this route builds the SDK-backed probe for `reconcileStuckAttempts`. Trust boundary: this is
// machine-to-machine, NOT a user session — a shared secret gates it, and with no secret set the
// route refuses to run at all rather than reconcile unauthenticated.
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { serverSecureClient } from "@/lib/polymarket-server";
import { reconcileStuckAttempts, type ReconcilableAttempt, type OrderVerdict, type TradeRecord } from "@/lib/reconcile";
import { captureToGlitchTip } from "@/lib/glitchtip";
import { fetchOrder, listAccountTrades } from "@polymarket/client/actions";

// A terminal verdict is what KILLS an attempt, so the terminal set is explicit and everything
// unrecognized reads as still-matchable (fail-safe).
const TERMINAL_STATUS = new Set(["matched", "canceled", "cancelled", "expired"]);

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

  // One client per OWNER, cached for this request — each attempt is probed with its own user's
  // credentials (the CLOB only reports an account its creds own).
  const clients = new Map<string, Awaited<ReturnType<typeof serverSecureClient>>>();

  const probe = async (attempt: ReconcilableAttempt): Promise<OrderVerdict | null> => {
    let client = clients.get(attempt.userId);
    if (client === undefined) {
      const user = await prisma.user.findUnique({ where: { id: attempt.userId } });
      client = user ? await serverSecureClient(prisma, user) : null;
      clients.set(attempt.userId, client);
    }
    if (!client || !attempt.externalOrderId) return null; // not configured / nothing to ask about

    try {
      // 0.6.0: fetchOrder is NOT curried (unlike postOrder).
      const order = (await fetchOrder(client as never, { orderId: attempt.externalOrderId })) as Record<
        string,
        unknown
      > | null;
      if (!order || typeof order !== "object") return null;

      const sizeMatched = Number(order.sizeMatched);
      if (!Number.isFinite(sizeMatched) || sizeMatched < 0) return null;
      const matchedSharesMicro = BigInt(Math.round(sizeMatched * 1_000_000));
      const terminal = TERMINAL_STATUS.has(String(order.status ?? "").toLowerCase());

      const trades: TradeRecord[] = [];
      if (matchedSharesMicro > 0n) {
        const rows = await listAccountTrades(client as never, { tokenId: attempt.tokenId })
          .firstPage()
          .then((p) => (p as { data?: unknown[] }).data ?? [])
          .catch(() => [] as unknown[]); // unreachable trades read as "no records" → unknown, retried
        const associated = Array.isArray(order.associateTrades) ? (order.associateTrades as unknown[]).map(String) : [];
        for (const raw of rows) {
          const t = raw as Record<string, unknown>;
          const id = String(t.id ?? "");
          // Only this order's trades: the taker order id is ours, or the order named the trade.
          if (String(t.takerOrderId ?? "") !== attempt.externalOrderId && !associated.includes(id)) continue;
          const price = Number(t.price);
          const size = Number(t.size);
          const feeRateBps = Number(t.feeRateBps);
          // A malformed record must never enter the money ledger — and an unparseable fee rate is
          // exactly the estimate this pass exists to remove, so drop that trade too.
          if (!id || !Number.isFinite(price) || price <= 0) continue;
          if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(feeRateBps) || feeRateBps < 0) continue;
          const stamped = t.matchedAt ?? t.updatedAt;
          const ts = stamped ? new Date(String(stamped)) : new Date();
          trades.push({
            id,
            priceBp: Math.round(price * 10_000),
            sizeMicro: BigInt(Math.round(size * 1_000_000)),
            feeRateBp: Math.round(feeRateBps),
            ts: Number.isNaN(ts.getTime()) ? new Date() : ts,
          });
        }
      }
      return { terminal, matchedSharesMicro, trades };
    } catch {
      return null; // any probe failure is "unknown": no writes, next pass retries
    }
  };

  try {
    const counts = await reconcileStuckAttempts(prisma, probe, { limit, minAgeMs });
    return NextResponse.json(counts);
  } catch (e) {
    await captureToGlitchTip(e, { route: "real/reconcile" });
    return NextResponse.json({ error: "reconcile_failed" }, { status: 500 });
  }
}
