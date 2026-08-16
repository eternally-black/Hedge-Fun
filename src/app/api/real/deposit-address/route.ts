// POST /api/real/deposit-address — the per-chain bridge deposit addresses for the caller's
// Deposit Wallet. Hard $5 minimum with margin over the moving ~$3 floor (§6.2): below it a
// deposit parks silently and indefinitely, which to the user looks exactly like theft.
import { NextResponse } from "next/server";
import { authUser } from "@/lib/privy";
import { isRealMoneyEligible, hasRealConsent, sameOrigin } from "@/lib/real";
import { captureToGlitchTip } from "@/lib/glitchtip";
import { MIN_DEPOSIT_USD } from "@/lib/config";

// In-memory cache keyed by wallet — the bridge is idempotent per wallet; successful responses
// only, 24h TTL (§6.2: this bridge moves operationally — never serve a rotated address forever).
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map<string, { at: number; data: unknown }>();

export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!isRealMoneyEligible(user)) {
    return NextResponse.json({ error: "real_disabled" }, { status: 403 });
  }
  if (!hasRealConsent(user)) {
    return NextResponse.json({ error: "consent_required" }, { status: 403 });
  }
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });

  const wallet = user.depositWalletAddress;
  if (!wallet) {
    return NextResponse.json({ error: "no_deposit_wallet" }, { status: 409 });
  }

  const cached = cache.get(wallet);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return NextResponse.json({ minUsd: MIN_DEPOSIT_USD, addresses: cached.data });
  }

  const code = process.env.POLYMARKET_BUILDER_CODE; // PUBLIC builder code — attribution, not a secret.

  let bridgeRes: Response;
  try {
    bridgeRes = await fetch("https://bridge.polymarket.com/deposit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(code ? { "X-Builder-Code": code } : {}),
      },
      body: JSON.stringify({ address: wallet }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    await captureToGlitchTip(e, { route: "real/deposit-address", stage: "bridge-fetch" });
    return NextResponse.json({ error: "bridge_unavailable" }, { status: 502 });
  }
  if (!bridgeRes.ok) {
    await captureToGlitchTip(new Error(`bridge deposit ${bridgeRes.status}`), { route: "real/deposit-address" });
    return NextResponse.json({ error: "bridge_unavailable" }, { status: 502 });
  }

  const addresses: unknown = await bridgeRes.json();
  if (typeof addresses !== "object" || addresses === null) {
    await captureToGlitchTip(new Error("bridge deposit: non-object body"), { route: "real/deposit-address" });
    return NextResponse.json({ error: "bridge_unavailable" }, { status: 502 });
  }
  cache.set(wallet, { at: Date.now(), data: addresses });

  return NextResponse.json({ minUsd: MIN_DEPOSIT_USD, addresses });
}
