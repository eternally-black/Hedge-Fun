// POST /api/builder/sign — @polymarket/client's remote-builder-signing contract. A browser-side
// SecureClient posts {method, path, body} here and gets back builder HMAC headers, so the browser
// can authenticate as OUR builder (attribution + gasless relayer access) while the builder secret
// stays server-side. This is what makes the D5 non-custodial split possible: keys in the device,
// builder identity on the server, neither one ever crossing.
// The allowlist is narrow on purpose — a builder key can revoke ITSELF and can burn the relayer
// quota, so an unrecognised path is refused and reported rather than signed.
import { NextResponse } from "next/server";
import { buildHmacSignature } from "@polymarket/client";
import { authUser } from "@/lib/privy";
import { isRealMoneyEligible, hasRealConsent, sameOrigin } from "@/lib/real";
import { captureToGlitchTip } from "@/lib/glitchtip";

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 240;
// One app container per compose (verified topology), so a module-level map is the whole story. The
// ceiling bounds a runaway client loop — every CLOB read in the browser costs one call here — it is
// not a policy limit.
const rateBuckets = new Map<string, { windowStartMs: number; count: number }>();

const ALLOWED_POST_PATHS = new Set(["/submit", "/order", "/orders", "/auth/api-key"]);

export async function POST(req: Request) {
  const user = await authUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isRealMoneyEligible(user)) return NextResponse.json({ error: "real_disabled" }, { status: 403 });
  if (!hasRealConsent(user)) return NextResponse.json({ error: "consent_required" }, { status: 403 });
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });

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
  if (!(verb === "GET" || (verb === "POST" && ALLOWED_POST_PATHS.has(route)))) {
    // Refuse AND report: a path outside the set is either an attack or an SDK call we have to widen
    // deliberately. `DELETE /auth/builder-api-key` revokes our builder key outright.
    await captureToGlitchTip(new Error(`builder sign refused: ${verb} ${route}`), {
      route: "builder/sign",
      method: verb,
      path: route,
      userId: user.id,
    });
    return NextResponse.json({ error: "path_not_allowed" }, { status: 403 });
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
