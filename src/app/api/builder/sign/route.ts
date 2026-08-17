// POST /api/builder/sign — @polymarket/client's remote-builder-signing contract. A browser-side
// SecureClient posts {method, path, body} here and gets back builder HMAC headers, so the browser
// can authenticate as OUR builder (attribution + gasless relayer access) while the HMAC secret
// stays server-side. This is what makes the D5 non-custodial split possible: keys in the device,
// builder identity on the server, neither one ever crossing.
// CORRECTION to the plan's "only the server ever sees builder creds": the response necessarily
// hands the browser the builder API KEY and PASSPHRASE, because the SDK forwards them as request
// headers. Only the HMAC SECRET never leaves this process.
// The allowlist is narrow and every POST body is BOUND to the caller — without that, one eligible
// user can spend the shared relayer quota deploying wallets for other EOAs under our builder, or
// post orders for an account this session does not own (S9 review, both reviewers).
import { NextResponse } from "next/server";
import { authUser, syncEmbeddedWallet } from "@/lib/privy";
import { isRealMoneyEligible, hasRealConsent, sameOrigin } from "@/lib/real";
import { captureToGlitchTip } from "@/lib/glitchtip";

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 240;
// One app container per compose (verified topology), so a module-level map is the whole story. The
// ceiling bounds a runaway client loop — every CLOB read in the browser costs one call here — it is
// not a policy limit.
const rateBuckets = new Map<string, { windowStartMs: number; count: number }>();

const ALLOWED_POST_PATHS = new Set(["/submit", "/order", "/orders", "/auth/api-key"]);
// These GETs read our BUILDER IDENTITY rather than market data. Everything else stays open: the
// SDK's read set (books, tick size, /deployed, /v1/account/transactions/*, /auth/derive-api-key) is
// wide, and a wrong refusal breaks the console.
//
// `/auth/api-keys` USED to be on this list and is not any more. It was denied precautionarily,
// pending evidence — and the evidence arrived: it is a normal step of the SDK's auth flow, called to
// validate the credentials we hand it, and denying it failed every real order with nothing but
// "Remote signer rejected request with status 403". It was invisible before only because the client
// derived fresh credentials instead, and died earlier on the CLOB's own 400.
//
// Allowing it exposes nothing new. The response is scoped by L2 auth to the TRADING account — the
// user's own deposit wallet — and the builder API key and passphrase are already handed to the
// browser on every call to this route, by protocol necessity (see the header above). The one secret
// that matters, the builder HMAC secret, never appears in a CLOB response at all.
const DENIED_GET_PATHS = new Set(["/auth/builder-api-key"]);

// Every refusal, in the log, always. The only reporter this route had was GlitchTip, which returns
// immediately when SENTRY_DSN is unset — so a 403 here was invisible on the server and showed up in
// the browser as a bare "Remote signer rejected request with status 403" with no way to tell WHICH
// of the five refusals fired. Addresses are public on-chain identifiers, not secrets, and this is
// the one place that can say why we would not sign.
function refused(reason: string, detail: Record<string, unknown>): void {
  console.warn(`[builder/sign] refused ${reason}`, JSON.stringify(detail));
}

const sameAddress = (value: unknown, expected: string | null | undefined) =>
  typeof value === "string" && typeof expected === "string" && value.toLowerCase() === expected.toLowerCase();

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isRealMoneyEligible(user)) {
    refused("real_disabled", { userId: user.id });
    return NextResponse.json({ error: "real_disabled" }, { status: 403 });
  }
  if (!hasRealConsent(user)) {
    refused("consent_required", { userId: user.id });
    return NextResponse.json({ error: "consent_required" }, { status: 403 });
  }
  if (!sameOrigin(req)) {
    refused("bad_origin", { origin: req.headers.get("origin"), expected: process.env.APP_ORIGIN });
    return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const { body, method, path } = raw as { body?: unknown; method?: unknown; path?: unknown };
  if (typeof method !== "string" || typeof path !== "string" || (body !== undefined && typeof body !== "string")) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // Rate limit BEFORE the allowlist: a loop hammering refused paths would otherwise flood ops.
  const now = Date.now();
  const bucket = rateBuckets.get(user.id);
  if (!bucket || bucket.windowStartMs + RATE_LIMIT_WINDOW_MS <= now) {
    rateBuckets.set(user.id, { windowStartMs: now, count: 1 });
  } else if (++bucket.count > RATE_LIMIT_MAX) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const verb = method.toUpperCase();
  const route = path.split("?")[0];
  const allowed =
    (verb === "GET" && !DENIED_GET_PATHS.has(route)) || (verb === "POST" && ALLOWED_POST_PATHS.has(route));
  if (!allowed) {
    // Refuse AND report: a path outside the set is either an attack or an SDK call we have to widen
    // deliberately. `DELETE /auth/builder-api-key` revokes our builder key outright.
    await captureToGlitchTip(new Error(`builder sign refused: ${verb} ${route}`), {
      route: "builder/sign",
      method: verb,
      path: route,
      userId: user.id,
    });
    refused("path_not_allowed", { verb, route });
    return NextResponse.json({ error: "path_not_allowed" }, { status: 403 });
  }

  // Bind the body to THIS caller. Fail closed: a body we cannot read is one we cannot attribute,
  // and an unattributable signature is exactly the abuse both reviewers described.
  // `/auth/api-key` is exempt — the SDK sends it with headers only (no body at all), and it is
  // L1-authed, so it already binds to the signer's own address.
  if (verb === "POST" && route !== "/auth/api-key") {
    let parsed: unknown;
    if (typeof body !== "string") {
      refused("unbound_body", { route, reason: "no body" });
      return NextResponse.json({ error: "unbound_body" }, { status: 400 });
    }
    try {
      parsed = JSON.parse(body);
    } catch {
      refused("unbound_body", { route, reason: "not json" });
      return NextResponse.json({ error: "unbound_body" }, { status: 400 });
    }
    const refuse = (detail: Record<string, unknown>) => {
      refused("not_your_wallet", { route, ...detail });
      return NextResponse.json({ error: "not_your_wallet" }, { status: 403 });
    };

    if (route === "/submit") {
      // Relayer envelope: `from` is the EOA that signed it; deposit-wallet batches also name the
      // wallet they execute on. Both must be this user's.
      //
      // The column is NULL for every account created before it existed, and the ONLY thing that
      // backfills it is /api/real/wallet — which provisionReal does not call until AFTER
      // deployDepositWallet has already come through here. So the very first real-money action an
      // existing user takes refused itself as not_your_wallet, which is what "Set up failed" was.
      // Backfilled here rather than in authUser because this route also serves every CLOB read
      // (240/min); gating the sync on NULL keeps it to one Privy call, once, per legacy account.
      let signerAddress = user.embeddedWalletAddress;
      if (!signerAddress) {
        try {
          signerAddress = await syncEmbeddedWallet(user);
        } catch {
          // address already bound to another account — never sign for it
          return refuse({ field: "signer", reason: "wallet sync failed" });
        }
      }
      const envelope = asRecord(parsed);
      if (!envelope || !sameAddress(envelope.from, signerAddress)) {
        return refuse({ field: "from", got: envelope?.from ?? null, expected: signerAddress });
      }
      const wallet = asRecord(envelope.depositWalletParams)?.depositWallet;
      if (wallet !== undefined && !sameAddress(wallet, user.depositWalletAddress)) {
        return refuse({ field: "depositWallet", got: wallet, expected: user.depositWalletAddress });
      }
    } else if (route === "/order" || route === "/orders") {
      // `{deferExec, order}` for one, an array of those for a batch. The maker is the funding
      // account, so binding it stops a session from trading for anyone else under our attribution.
      const payloads = route === "/orders" ? parsed : [parsed];
      if (!Array.isArray(payloads)) return refuse({ field: "payloads", got: typeof parsed });
      for (const entry of payloads) {
        const order = asRecord(asRecord(entry)?.order);
        if (!order || !sameAddress(order.maker, user.depositWalletAddress)) {
          // `keys` is here because the binding depends on the SDK calling this field `maker`; if a
          // version renames it (signer/funder), the refusal is indistinguishable from a genuine
          // mismatch without seeing what the payload actually contained.
          return refuse({
            field: "maker",
            got: order?.maker ?? null,
            expected: user.depositWalletAddress,
            keys: order ? Object.keys(order) : null,
          });
        }
      }
    }
  }

  const key = process.env.POLYMARKET_BUILDER_API_KEY;
  const secret = process.env.POLYMARKET_BUILDER_SECRET;
  const passphrase = process.env.POLYMARKET_BUILDER_PASSPHRASE;
  if (!key || !secret || !passphrase) {
    return NextResponse.json({ error: "real_not_configured" }, { status: 503 });
  }

  const timestamp = Math.floor(Date.now() / 1000);
  let signature: string;
  try {
    // Imported HERE rather than at module scope: the SDK's root entry is a barrel that pulls its
    // whole transport graph, including pure-ESM packages the tsx test runner cannot resolve as CJS.
    // At module scope that made this route unimportable from a test — so the one route that decides
    // whether we sign for a given wallet was the one route with no test. Nothing is deferred that
    // matters in production: Next bundles it either way, and every access decision above is already
    // made by the time we get here.
    const { buildHmacSignature } = await import("@polymarket/client");
    // The SDK's own helper — signing the caller's method/path/body VERBATIM (not the uppercased
    // copy used for matching) is what keeps this concatenation identical to the one the CLOB
    // recomputes; any normalization here would read as a bad signature there.
    signature = await buildHmacSignature(secret, timestamp, method, path, body);
  } catch (e) {
    await captureToGlitchTip(e, { route: "builder/sign", stage: "hmac" });
    return NextResponse.json({ error: "sign_failed" }, { status: 500 });
  }

  return NextResponse.json(
    {
      POLY_BUILDER_API_KEY: key,
      POLY_BUILDER_PASSPHRASE: passphrase,
      POLY_BUILDER_SIGNATURE: signature,
      POLY_BUILDER_TIMESTAMP: String(timestamp),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
