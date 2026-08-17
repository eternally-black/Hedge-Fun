// POST /api/real/deposit-address — the per-chain bridge deposit addresses for the caller's
// Deposit Wallet. Hard $5 minimum with margin over the moving ~$3 floor (§6.2): below it a
// deposit parks silently and indefinitely, which to the user looks exactly like theft.
import { NextResponse } from "next/server";
import { authUser } from "@/lib/privy";
import { isRealMoneyEligible, hasRealConsent, sameOrigin } from "@/lib/real";
import { captureToGlitchTip } from "@/lib/glitchtip";
import { MIN_DEPOSIT_USD } from "@/lib/config";
import { fetchSupportedAssets } from "@/lib/bridge";
import { depositChains, type DepositChain } from "@/lib/deposit-chains";

// In-memory cache keyed by wallet — the bridge is idempotent per wallet; successful responses
// only, 24h TTL (§6.2: this bridge moves operationally — never serve a rotated address forever).
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map<string, { at: number; data: DepositChain[] }>();

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
    return NextResponse.json({ minUsd: MIN_DEPOSIT_USD, chains: cached.data });
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

  const body: unknown = await bridgeRes.json();
  // The bridge answers { address: { evm, svm, tron, btc }, note, warnings } — the addresses are one
  // level DOWN. This route used to hand the whole envelope back as `addresses`, and the client, which
  // kept only the string-valued entries, ended up rendering `note` as if it were a chain and its text
  // as if it were an address. Reading the nested object is the fix; refusing a body without it is
  // what stops the same class of mistake from ever being silent again.
  const addresses = (body as { address?: unknown })?.address;
  if (typeof addresses !== "object" || addresses === null || Array.isArray(addresses)) {
    await captureToGlitchTip(new Error("bridge deposit: no address object"), { route: "real/deposit-address" });
    return NextResponse.json({ error: "bridge_unavailable" }, { status: 502 });
  }

  let chains;
  try {
    chains = depositChains(await fetchSupportedAssets(), addresses as Record<string, unknown>);
  } catch (e) {
    // Without the asset list there is no chain to name, no minimum to quote and no way to say which
    // token belongs where — showing a bare address with none of that is how money lands on the wrong
    // network. Fail the whole call instead.
    await captureToGlitchTip(e, { route: "real/deposit-address", stage: "supported-assets" });
    return NextResponse.json({ error: "bridge_unavailable" }, { status: 502 });
  }
  if (chains.length === 0) {
    await captureToGlitchTip(new Error("bridge deposit: no usable chains"), { route: "real/deposit-address" });
    return NextResponse.json({ error: "bridge_unavailable" }, { status: 502 });
  }

  cache.set(wallet, { at: Date.now(), data: chains });
  return NextResponse.json({ minUsd: MIN_DEPOSIT_USD, chains });
}
