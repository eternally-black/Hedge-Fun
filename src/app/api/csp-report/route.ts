import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/ratelimit";
import { clientIp } from "@/lib/refclick";
import { captureToGlitchTip } from "@/lib/glitchtip";

// CSP violation report endpoint. The browser POSTs a JSON report when a policy directive is
// violated; we forward a whitelisted subset to GlitchTip for ops visibility. Unauthenticated by
// design — the browser has no session at report time, and the report must never fail the page
// (always 204). Capped: a report body is untrusted input, so we refuse anything over 8KB and
// never spread the raw report into the error payload.
export const runtime = "nodejs";

const MAX_BODY_BYTES = 8_192;
const MAX_FIELD_CHARS = 200;

function cap(value: unknown): string {
  const s = typeof value === "string" ? value : String(value ?? "");
  return s.length > MAX_FIELD_CHARS ? s.slice(0, MAX_FIELD_CHARS) : s;
}

export async function POST(req: Request) {
  // Rate-limit per client IP: a misbehaving page could otherwise flood GlitchTip with reports.
  if (!rateLimit(`csp-report:${clientIp(req.headers)}`, 10, 60_000)) {
    return new NextResponse(null, { status: 204 });
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return new NextResponse(null, { status: 413 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Junk body — never fail the page, just drop it.
    return new NextResponse(null, { status: 204 });
  }

  // Accept either the legacy single-report shape ({ "csp-report": {...} }, what report-uri sends)
  // or the report-to array shape ([{ body: {...} }, ...]).
  const reports: unknown[] = [];
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (item && typeof item === "object") reports.push((item as Record<string, unknown>)["body"]);
    }
  } else if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (obj["csp-report"] && typeof obj["csp-report"] === "object") reports.push(obj["csp-report"]);
  }

  for (const report of reports) {
    if (!report || typeof report !== "object") continue;
    const r = report as Record<string, unknown>;
    const directive = cap(r["effective-directive"] ?? r["effectiveDirective"]);
    const blockedUri = cap(r["blocked-uri"] ?? r["blockedURL"]);
    const documentUri = cap(r["document-uri"] ?? r["documentURL"]);
    const sourceFile = cap(r["source-file"] ?? r["sourceFile"]);
    const lineNumber = cap(r["line-number"] ?? r["lineNumber"]);
    void captureToGlitchTip(
      new Error(`csp: ${directive} blocked ${blockedUri}`),
      { route: "csp-report", directive, blockedUri, documentUri, sourceFile, lineNumber },
    );
  }

  return new NextResponse(null, { status: 204 });
}
