// DB-free self-check for the CSP report endpoint. Same style as test-quote.ts — node:assert,
// no framework, no DB, no network. Run: npx tsx scripts/test-csp-report.ts
import assert from "node:assert";
import { POST } from "../src/app/api/csp-report/route";

async function main() {
  // A well-formed legacy report is accepted (204).
  const ok = await POST(new Request("http://localhost/api/csp-report", {
    method: "POST",
    headers: { "content-type": "application/csp-report", "x-forwarded-for": "203.0.113.5" },
    body: JSON.stringify({
      "csp-report": {
        "effective-directive": "script-src",
        "blocked-uri": "https://evil.example/x.js",
        "document-uri": "https://app.hedgeyour.fun/",
      },
    }),
  }));
  assert.strictEqual(ok.status, 204, "valid report -> 204");

  // An oversize body is refused with 413.
  const big = await POST(new Request("http://localhost/api/csp-report", {
    method: "POST",
    headers: { "content-type": "application/csp-report", "x-forwarded-for": "203.0.113.5" },
    body: JSON.stringify({ "csp-report": { "blocked-uri": "x".repeat(9_000) } }),
  }));
  assert.strictEqual(big.status, 413, "oversize body -> 413");

  // Junk that isn't JSON never fails the page (204).
  const junk = await POST(new Request("http://localhost/api/csp-report", {
    method: "POST",
    headers: { "content-type": "application/csp-report", "x-forwarded-for": "203.0.113.5" },
    body: "not json",
  }));
  assert.strictEqual(junk.status, 204, "non-JSON body -> 204");

  console.log("✓ csp-report: accepts a report, refuses an oversize body, never fails on junk");
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
