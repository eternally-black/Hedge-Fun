// A wall-clock budget carried through AsyncLocalStorage (stdlib), so upstream readers can honour it
// without a signature change: withDeadline(ms, fn) sets it for everything awaited inside fn, and a
// reader calls deadlineLeftMs() before each request — refusing once it is spent — and clamps its own
// timeout with boundedTimeoutMs(). Readers today: the Gamma client (src/lib/polymarket.ts), the CLOB
// client (src/lib/clob.ts) and the Polygon RPC client (src/lib/polygon.ts). Outside withDeadline
// there is no budget and every reader behaves exactly as before.
//
// Why not a module variable: the app server shares these readers across concurrent requests.
// Why at all: on 2026-09-02 a slow Gamma outage stretched one poller tick past the 180 s heartbeat
// bound and the watchdog restarted a live poller three times into the same outage (scripts/poller.ts
// has the budgets and the arithmetic).
import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<number>();

export function withDeadline<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  return store.run(Date.now() + ms, fn);
}

// undefined = no budget in force; <= 0 = spent.
export function deadlineLeftMs(): number | undefined {
  const deadline = store.getStore();
  return deadline === undefined ? undefined : deadline - Date.now();
}

// One request's timeout under the budget: the reader's own bound or what is left, whichever is
// smaller — never 0, because AbortSignal.timeout(0) aborts before the request is even issued.
export function boundedTimeoutMs(ownMs: number): number {
  return Math.max(1, Math.min(ownMs, deadlineLeftMs() ?? ownMs));
}
