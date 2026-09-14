// Browser-side error reporting for the money paths.
//
// 2026-09-13: "Set up trading wallet" failed for a user with "Setup failed. Try again." and the server
// had NOTHING — no refused sign, no route error, no GlitchTip event. The throw came from the Privy
// wallet or the Polymarket SDK on the device, before any route of ours ran, and the card folded it
// into a fixed string. The only evidence was a screenshot. Every real-money entry point now routes its
// failure through `reported`, so a browser-side error lands in `docker logs` and GlitchTip with the
// stage it died at — and is rethrown unchanged, so callers keep their own handling.
//
// React-free and SDK-free on purpose: the screens, the client orchestrator and a test can all use it.

type Api = (path: string, init?: RequestInit) => Promise<unknown>;

export type ErrorReport = {
  where: string;
  stage?: string;
  name: string;
  message: string;
  status?: number;
  code?: string;
  stack?: string;
};

// A page that has gone wrong tends to keep going wrong. The server rate-limits per user too, but a
// loop should not cost a network round-trip per iteration on the way there.
const MAX_REPORTS_PER_PAGE = 20;
let sent = 0;

const cap = (value: unknown, max: number): string => {
  const s = typeof value === "string" ? value : String(value ?? "");
  return s.length > max ? s.slice(0, max) : s;
};

function words(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e) ?? String(e);
  } catch {
    return String(e);
  }
}

// What a thrown value can tell about itself, capped. `status`/`body.error` are the shape our own
// `api()` wrapper throws (useApi.ts); `stage` is what `step` attaches; the rest is any Error.
export function describeError(e: unknown): Omit<ErrorReport, "where"> {
  const o = (e ?? {}) as {
    status?: unknown;
    body?: { error?: unknown };
    stage?: unknown;
    cause?: unknown;
  };
  const cause = o.cause instanceof Error ? ` <- ${o.cause.message}` : "";
  return {
    name: cap(e instanceof Error ? e.name : typeof e, 60),
    message: cap(words(e) + cause, 500),
    ...(typeof o.status === "number" ? { status: o.status } : {}),
    ...(typeof o.body?.error === "string" ? { code: cap(o.body.error, 80) } : {}),
    ...(typeof o.stage === "string" ? { stage: cap(o.stage, 80) } : {}),
    ...(e instanceof Error && e.stack ? { stack: cap(e.stack, 1500) } : {}),
  };
}

// Ships one report. Never throws and never rejects: a failure to report must not become a second
// failure on top of the first, and the caller is usually already inside a catch block.
export async function reportClientError(api: Api, where: string, e: unknown): Promise<void> {
  if (sent >= MAX_REPORTS_PER_PAGE) return;
  sent++;
  try {
    await api("/api/client-report", {
      method: "POST",
      body: JSON.stringify({ where: cap(where, 80), ...describeError(e) } satisfies ErrorReport),
    });
  } catch {
    // Swallowed by design — see above.
  }
}

// Runs `fn` and tags any throw with the stage it came from. The innermost tag wins: a stage set deeper
// in the call is the more precise one. Rides on the error object itself, so nothing is re-wrapped and
// `instanceof` checks upstream keep working.
export async function step<T>(stage: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e && typeof e === "object" && !("stage" in e)) {
      try {
        (e as { stage?: string }).stage = stage;
      } catch {
        // frozen error object — the report just goes out without a stage
      }
    }
    throw e;
  }
}

// Runs `fn`; a failure is reported under `where` and rethrown as-is. Errors that carry a server error
// code are NOT reported: the server produced that answer and already knows (a 409 price_moved on a
// swipe is a normal outcome, not an incident). Everything else — a Privy signer that refused, an SDK
// call that timed out, a network failure, a 5xx with no JSON body — is exactly what was invisible.
export async function reported<T>(api: Api, where: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!describeError(e).code) void reportClientError(api, where, e);
    throw e;
  }
}

// The line a card shows for a failure. A server error code stays the code (the cards already map
// those); anything else gets the stage and the error's own words, so a screenshot names the culprit
// instead of "Setup failed. Try again." meaning six different things.
export function failText(e: unknown, fallback: string): string {
  const d = describeError(e);
  if (d.code) return d.code;
  const detail = [d.stage, d.message].filter(Boolean).join(": ");
  return detail ? `${fallback} (${cap(detail, 140)}). Try again.` : `${fallback}. Try again.`;
}
