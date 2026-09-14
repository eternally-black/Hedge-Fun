// POST /api/client-report — the browser's error channel. The real-money paths fail on the DEVICE:
// Privy signing, the Polymarket SDK's derive/deploy/post calls all run in the browser, before any
// route of ours is reached, and until 2026-09-13 such a failure lived only in a React state string.
// This turns it into a server log line AND a GlitchTip event, tagged with who and where.
//
// Authenticated so a report names its user and the channel cannot be flooded anonymously; capped and
// field-limited because the body is untrusted input; identity only — no user row is read or written,
// so it works even when the DB is what broke. The client swallows every outcome (client-report.ts).
import { NextResponse } from "next/server";
import { bearer, verifyPrivyToken } from "@/lib/privy";
import { rateLimit } from "@/lib/ratelimit";
import { captureToGlitchTip } from "@/lib/glitchtip";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 8_192;
const RATE_LIMIT_PER_MINUTE = 10;
// Field → max chars. Anything not listed is dropped, so a report can never smuggle a payload.
const FIELDS: Array<[string, number]> = [
  ["where", 80],
  ["stage", 80],
  ["name", 60],
  ["message", 500],
  ["code", 80],
  ["stack", 1500],
];

export async function POST(req: Request) {
  const token = bearer(req);
  if (!token) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let privyId: string;
  try {
    privyId = await verifyPrivyToken(token);
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Before the body: a page stuck in an error loop must not cost us parsing per iteration.
  if (!rateLimit(`client-report:${privyId}`, RATE_LIMIT_PER_MINUTE, 60_000)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return new NextResponse(null, { status: 413 });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const r = parsed as Record<string, unknown>;
  const report: Record<string, string> = { privyId };
  for (const [key, max] of FIELDS) {
    const v = r[key];
    if (typeof v === "string" && v) report[key] = v.length > max ? v.slice(0, max) : v;
  }
  if (typeof r.status === "number" && Number.isFinite(r.status)) report.status = String(r.status);
  if (!report.message && !report.name) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  // The log line is the primary record — it is what `docker compose logs app | grep client-report`
  // finds, and it does not depend on GlitchTip being up.
  console.warn("[client-report]", JSON.stringify(report));

  const { stack, ...tags } = report;
  const err = new Error(
    `client ${report.where ?? "?"}${report.stage ? `/${report.stage}` : ""}: ${report.name ?? "Error"}: ${report.message ?? ""}`,
  );
  // The browser's stack, not this handler's — that is the one that says where it died.
  err.stack = stack ?? err.message;
  await captureToGlitchTip(err, { route: "client-report", ...tags });

  return new NextResponse(null, { status: 204 });
}
