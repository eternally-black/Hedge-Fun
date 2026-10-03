// Types for the CommonJS stub installer (see polymarket-client-hooks.cjs).
declare const stub: {
  __stubCalls: { prepared: number; fetched: number; txState: string | null };
};
export = stub;
