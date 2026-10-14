// Canary exit classification. The daily canary must not page "Polymarket integration drifted" for
// an upstream outage — the 2026-10-13 red run was a single runner-side Gamma timeout
// ("The operation was aborted due to timeout (after 4 attempts)") while prod read Gamma fine.
//
// Exit codes:
//   1 = drift (an assertion failed, or anything we cannot classify) — real, page it.
//   3 = upstream unreachable (429/5xx/timeout/transport after the retry ladder) — the workflow
//       retries these, then alerts as an OUTAGE, not drift.
//
// The distinction is only sound because the retry ladders in src/lib/polymarket.ts and
// src/lib/clob.ts exhaust ONLY on retryable conditions: a non-429 4xx is rethrown immediately, so
// "Gamma 404 for /x" and "CLOB 404 (not retryable)" are contract problems (drift), never outages.
import assert from "node:assert";

export const CANARY_EXIT_DRIFT = 1;
export const CANARY_EXIT_UNREACHABLE = 3;

// Transport-level errno codes that mean "the network, not the API, failed".
const TRANSPORT_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EPIPE"]);

function hasTransportCode(e: unknown): boolean {
  // Walk up to 3 levels of `.cause` — undici wraps the real errno one or two levels down.
  let cur: unknown = e;
  for (let depth = 0; depth < 3 && cur; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && (TRANSPORT_CODES.has(code) || code.startsWith("UND_ERR_"))) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

export function isUpstreamUnreachable(e: unknown): boolean {
  // A failed assertion is drift by definition — never an outage.
  if (!(e instanceof Error)) return false;
  if (e instanceof assert.AssertionError) return false;

  // AbortSignal.timeout() / AbortController.abort() surface as these names.
  if (e.name === "TimeoutError" || e.name === "AbortError") return true;

  // gammaGetWithRetry only exhausts its ladder on 429/5xx/timeout/transport (a non-429 4xx is
  // rethrown immediately), so this suffix is a reliable outage marker.
  if (/\(after \d+ attempts\)$/.test(e.message)) return true;
  // postBooksWithRetry's exhausted-ladder message.
  if (/^CLOB \/books failed after \d+ attempts/.test(e.message)) return true;

  // A bare status error that reached us un-retried: 429 or 5xx is congestion/outage.
  if (/^(Gamma|CLOB) (429|5\d\d)\b/.test(e.message)) return true;

  // undici's generic transport failure.
  if (e.name === "TypeError" && e.message === "fetch failed") return true;

  return hasTransportCode(e);
}

export function canaryFail(label: string, e: unknown): never {
  if (isUpstreamUnreachable(e)) {
    console.error(`${label} UNREACHABLE (upstream outage, not drift):`, e);
    process.exit(CANARY_EXIT_UNREACHABLE);
  }
  console.error(`${label} FAILED:`, e);
  process.exit(CANARY_EXIT_DRIFT);
}
