// POST /api/real/deposit-address — the per-chain bridge deposit addresses for the caller's
// Deposit Wallet. Hard $5 minimum with margin over the moving ~$3 floor (§6.2): below it a
// deposit parks silently and indefinitely, which to the user looks exactly like theft.
import { NextResponse } from "next/server";
import { authUser } from "@/lib/privy";
import { isRealMoneyEligible } from "@/lib/real";
import { MIN_DEPOSIT_USD } from "@/lib/config";

// In-memory cache keyed by wallet — the bridge is idempotent per wallet; successful responses only.
const cache = new Map<string, unknown>();

export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!isRealMoneyEligible(user)) {
    return NextResponse.json({ error: "real_disabled" }, { status: 403 });
  }

  const wallet = user.depositWalletAddress;
  if (!wallet) {
    return NextResponse.json({ error: "no_deposit_wallet" }, { status: 409 });
  }

  const cached = cache.get(wallet);
  if (cached) {
    return NextResponse.json({ minUsd: MIN_DEPOSIT_USD, addresses: cached });
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
  } catch {
    return NextResponse.json({ error: "bridge_unavailable" }, { status: 502 });
  }
  if (!bridgeRes.ok) {
    return NextResponse.json({ error: "bridge_unavailable" }, { status: 502 });
  }

  const addresses = await bridgeRes.json();
  cache.set(wallet, addresses);

  return NextResponse.json({ minUsd: MIN_DEPOSIT_USD, addresses });
}
