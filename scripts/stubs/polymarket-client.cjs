// A stand-in for @polymarket/client (and its /actions, /node subpaths) in route-level tests that run
// under tsx. Two reasons it exists: the real SDK pulls it-queueless-pushable -> race-signal, whose
// package exports break Node's resolver under tsx (ERR_PACKAGE_PATH_NOT_EXPORTED — the same wall
// scripts/test-order-probe.ts hit), and a route test must never reach the relayer anyway.
// Installed by scripts/stubs/polymarket-client-hooks.cjs (module.registerHooks) BEFORE the route is
// imported; only the names the withdraw route's import graph uses are provided, on purpose — a new
// SDK import in that graph fails loudly here instead of silently talking to production.
const calls = { prepared: 0, fetched: 0 };

module.exports = {
  __stubCalls: calls,
  // polymarket-server.ts: assembled once per user; nothing here ever talks to the exchange.
  createSecureClient: async (opts) => ({ stub: true, wallet: (opts && opts.wallet) || null }),
  builderApiKey: (k) => k,
  // relayer-verdict.ts: "probe unreachable" -> the verdict is "unknown" and the balance predicates
  // (or, for resetNeedsProof specs, the hold) stay in charge.
  fetchTransaction: async () => {
    calls.fetched++;
    throw new Error("stub: relayer unreachable");
  },
  // bridge-out.ts: the gasless generator. Same protocol as the SDK's: the engine answers
  // requestAddress itself (autoAnswer), then parks on the signature request.
  prepareGaslessTransaction: (_client, opts) => {
    calls.prepared++;
    return (async function* () {
      const signer = yield { kind: "requestAddress" };
      yield {
        kind: "signTypedData",
        payload: { signer, calls: (opts && opts.calls) || [], metadata: (opts && opts.metadata) || null },
      };
      return { transactionId: "stub-tx" };
    })();
  },
};
