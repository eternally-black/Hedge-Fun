// A wall-clock budget carried through AsyncLocalStorage, so upstream readers can honour it without
// a signature change: withDeadline(ms, fn) sets it for everything awaited inside fn, and a reader
// calls deadlineLeftMs() before each request — refusing once it is spent — and clamps its own
// timeout with boundedTimeoutMs(). Readers today: the Gamma client (src/lib/polymarket.ts), the CLOB
// client (src/lib/clob.ts) and the Polygon RPC client (src/lib/polygon.ts). Outside withDeadline
// there is no budget and every reader behaves exactly as before.
//
// Why not a module variable: the app server shares these readers across concurrent requests.
// Why at all: on 2026-09-02 a slow Gamma outage stretched one poller tick past the 180 s heartbeat
// bound and the watchdog restarted a live poller three times into the same outage (scripts/poller.ts
// has the budgets and the arithmetic).
//
// The storage is obtained at runtime, NOT imported: polygon.ts is reached from browser bundles
// (real-client → relay-guard → wallet-ops, for the token addresses), and a static
// `import "node:async_hooks"` failed the client build ("the chunking context does not support
// external modules", deploy run 33662610575). process.getBuiltinModule (Node ≥ 22.3; the image is
// node:24) is a plain call bundlers leave alone; wherever it is missing — browser, edge — there is
// simply no budget, which is the same as never calling withDeadline.
import type { AsyncLocalStorage } from "node:async_hooks";

type Store = AsyncLocalStorage<number>;

const store: Store | undefined = (() => {
  const p = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  if (typeof p?.getBuiltinModule !== "function") return undefined;
  const mod = p.getBuiltinModule("node:async_hooks") as { AsyncLocalStorage: new () => Store } | undefined;
  return mod ? new mod.AsyncLocalStorage() : undefined;
})();

export function withDeadline<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  return store ? store.run(Date.now() + ms, fn) : fn();
}

// undefined = no budget in force; <= 0 = spent.
export function deadlineLeftMs(): number | undefined {
  const deadline = store?.getStore();
  return deadline === undefined ? undefined : deadline - Date.now();
}

// One request's timeout under the budget: the reader's own bound or what is left, whichever is
// smaller — never 0, because AbortSignal.timeout(0) aborts before the request is even issued.
export function boundedTimeoutMs(ownMs: number): number {
  return Math.max(1, Math.min(ownMs, deadlineLeftMs() ?? ownMs));
}
