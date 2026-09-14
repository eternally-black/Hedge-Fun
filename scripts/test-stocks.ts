// DB-free self-check for the tokenized-stocks PURE core (src/lib/stocks.ts). Same style as
// scripts/test-hedge-cores.ts — node:assert, no framework, no DB, no network.
// Run: npx tsx scripts/test-stocks.ts
import assert from "node:assert";
import {
  xstockToAsset,
  priceFieldsFrom,
  isDeckEligible,
  qtyBaseFor,
  valueCents,
  entryPriceCents,
  usdcMicroToCents,
  livePnlCents,
  uiQty,
  parseSwapDelta,
  attemptMatches,
  parseJupQuote,
  decodeBase58,
  sigBytesValid,
  USDC_MINT,
  type RpcParsedTx,
} from "../src/lib/stocks";

// ─── xstockToAsset: Solana deployment selection, defaults, null trading ─────────────────────────────
{
  const node = {
    symbol: "AAPLx",
    name: "Apple xStock",
    logo: "https://example.com/AAPLx.png",
    underlyingSymbol: "AAPL",
    isTradingHalted: false,
    trading: { tradingHoursMode: "TwentyFourFive", openNow: true },
    deployments: [
      { network: "Ethereum", address: "0x1234567890abcdef" },
      { network: "Solana", address: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp" },
    ],
  };
  const a = xstockToAsset(node);
  assert.ok(a, "node with a Solana deployment parses");
  assert.strictEqual(a!.mint, "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", "mint is the Solana address, not the Ethereum one");
  assert.strictEqual(a!.symbol, "AAPLx");
  assert.strictEqual(a!.name, "Apple xStock");
  assert.strictEqual(a!.underlying, "AAPL");
  assert.strictEqual(a!.halted, false);
  assert.strictEqual(a!.tradingHours, "TwentyFourFive");
  assert.strictEqual(a!.openNow, true);

  const ethOnly = xstockToAsset({ symbol: "TSLAx", deployments: [{ network: "Ethereum", address: "0xdeadbeef" }] });
  assert.strictEqual(ethOnly, null, "Ethereum-only asset is not tradable here");

  const noTrading = xstockToAsset({
    symbol: "MSFTx",
    trading: null,
    deployments: [{ network: "Solana", address: "Mint111111111111111111111111111111111111111" }],
  });
  assert.ok(noTrading, "null trading still parses");
  assert.strictEqual(noTrading!.tradingHours, null, "null trading -> tradingHours null");
  assert.strictEqual(noTrading!.openNow, false, "null trading -> openNow false");

  const noName = xstockToAsset({
    symbol: "NVDAx",
    deployments: [{ network: "Solana", address: "Mint222222222222222222222222222222222222222" }],
  });
  assert.strictEqual(noName!.name, "NVDAx", "missing name defaults to symbol");
  assert.strictEqual(noName!.underlying, "NVDA", "underlying defaults to symbol minus trailing x");

  assert.strictEqual(xstockToAsset({ symbol: null, deployments: [{ network: "Solana", address: "x" }] }), null, "no symbol -> null");
  assert.strictEqual(xstockToAsset({ symbol: "AAPLx", deployments: [] }), null, "no deployments -> null");
  assert.strictEqual(
    xstockToAsset({ symbol: "AAPLx", deployments: [{ network: "Solana", address: "" }] }),
    null,
    "empty Solana address -> null",
  );
}

// ─── priceFieldsFrom: real Jupiter entry, saturation, nulls ─────────────────────────────────────────
{
  const real = priceFieldsFrom({
    usdPrice: 334.163344517126,
    decimals: 8,
    priceChange24h: 0.9412720442634717,
    liquidity: 851681.6154755391,
    scaledUiConfig: { multiplier: 1.0026642075893797 },
  });
  assert.deepStrictEqual(
    real,
    { priceCents: 33416, change24hBp: 94, liquidityCents: 85168162, decimals: 8, uiMultiplierMicro: 1002664 },
    "real Jupiter entry maps to the persisted fields",
  );

  assert.strictEqual(priceFieldsFrom({ usdPrice: 0 }), null, "usdPrice 0 -> null");
  assert.strictEqual(priceFieldsFrom(undefined), null, "undefined entry -> null");
  assert.strictEqual(priceFieldsFrom({}), null, "no usdPrice -> null");

  const huge = priceFieldsFrom({ usdPrice: 1, liquidity: 1e12 });
  assert.strictEqual(huge!.liquidityCents, 2_147_483_647, "liquidity saturates at INT4 max");

  const noMult = priceFieldsFrom({ usdPrice: 1 });
  assert.strictEqual(noMult!.uiMultiplierMicro, null, "no scaledUiConfig -> null multiplier");
  assert.strictEqual(noMult!.decimals, 8, "decimals defaults to 8");
  assert.strictEqual(noMult!.change24hBp, null, "no priceChange24h -> null");
}

// ─── isDeckEligible ─────────────────────────────────────────────────────────────────────────────────
{
  assert.strictEqual(isDeckEligible({ halted: false, priceCents: 100, liquidityCents: 2_500_000 }), true, "at the floor is eligible");
  assert.strictEqual(isDeckEligible({ halted: true, priceCents: 100, liquidityCents: 9_999_999 }), false, "halted -> not eligible");
  assert.strictEqual(isDeckEligible({ halted: false, priceCents: null, liquidityCents: 9_999_999 }), false, "unpriced -> not eligible");
  assert.strictEqual(isDeckEligible({ halted: false, priceCents: 100, liquidityCents: 2_499_999 }), false, "below the liquidity floor -> not eligible");
}

// ─── qtyBaseFor / valueCents / entryPriceCents / usdcMicroToCents / livePnlCents ────────────────────
{
  assert.strictEqual(qtyBaseFor(1000, 33416, 8), 2_992_578n, "$10 at $334.16 -> 0.02992578 raw units");
  assert.strictEqual(qtyBaseFor(1000, 0, 8), 0n, "zero price -> 0n");
  assert.strictEqual(qtyBaseFor(0, 33416, 8), 0n, "zero stake -> 0n");

  assert.strictEqual(valueCents(2_992_578n, 33416, 8), 999, "value at the entry price floors to 999 (never above the stake)");
  assert.strictEqual(valueCents(2_992_578n, 35000, 8), 1047, "value at $350 floors to 1047");

  assert.strictEqual(entryPriceCents(100, 299_330n, 8), 33_408, "entry price rounds from cost/qty");
  assert.strictEqual(entryPriceCents(1000, 2_992_578n, 8), 33_416, "entry price round-trips the quoted price");
  assert.strictEqual(entryPriceCents(100, 0n, 8), 0, "zero qty -> 0");

  assert.strictEqual(usdcMicroToCents(1_000_001n), 101, "a cost basis rounds UP");
  assert.strictEqual(usdcMicroToCents(1_000_000n), 100, "an exact dollar stays exact");
  assert.strictEqual(usdcMicroToCents(0n), 0, "zero -> 0");

  assert.strictEqual(livePnlCents({ qtyBase: 2_992_578n, costCents: 1000 }, { priceCents: 35000, decimals: 8 }), 47, "P&L = value - cost");
}

// ─── uiQty: display-only multiplier ─────────────────────────────────────────────────────────────────
{
  const withMult = uiQty(299_330n, 8, 1_002_664);
  assert.ok(Math.abs(withMult - 0.0030013) < 1e-7, `uiQty with multiplier ~0.0030013 (got ${withMult})`);
  assert.strictEqual(uiQty(299_330n, 8, null), 0.0029933, "uiQty without multiplier is the raw UI amount");
}

// ─── parseSwapDelta: the landed-tx reader ───────────────────────────────────────────────────────────
{
  const PAYER = "PayerPubkey111";
  const MINT = "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp";
  const base = (over: Partial<NonNullable<RpcParsedTx["meta"]>> = {}, keys?: { pubkey: string; signer?: boolean }[]): RpcParsedTx => ({
    meta: {
      err: null,
      preTokenBalances: [{ accountIndex: 1, mint: USDC_MINT, owner: PAYER, uiTokenAmount: { amount: "5000000", decimals: 6 } }],
      postTokenBalances: [
        { accountIndex: 1, mint: USDC_MINT, owner: PAYER, uiTokenAmount: { amount: "4000000", decimals: 6 } },
        { accountIndex: 2, mint: MINT, owner: PAYER, uiTokenAmount: { amount: "299330", decimals: 8 } },
      ],
      ...over,
    },
    transaction: { message: { accountKeys: keys ?? [{ pubkey: PAYER, signer: true }, { pubkey: "Other" }] } },
  });

  const ok = parseSwapDelta(base(), { payer: PAYER, mint: MINT });
  assert.deepStrictEqual(ok, { qtyBase: 299_330n, usdcOutMicro: 1_000_000n }, "reads the stock delta and the USDC spend");

  const failed = parseSwapDelta(base({ err: { InstructionError: [0, "Custom"] } }), { payer: PAYER, mint: MINT });
  assert.strictEqual(failed, null, "a failed tx books nothing");

  const wrongOwner = parseSwapDelta(
    base({
      postTokenBalances: [
        { accountIndex: 1, mint: USDC_MINT, owner: PAYER, uiTokenAmount: { amount: "4000000", decimals: 6 } },
        { accountIndex: 2, mint: MINT, owner: "Other", uiTokenAmount: { amount: "299330", decimals: 8 } },
      ],
    }),
    { payer: PAYER, mint: MINT },
  );
  assert.strictEqual(wrongOwner, null, "a stock balance owned by someone else is not our buy");

  const wrongPayer = parseSwapDelta(base({}, [{ pubkey: "Other", signer: true }, { pubkey: PAYER }]), { payer: PAYER, mint: MINT });
  assert.strictEqual(wrongPayer, null, "a tx whose fee payer is not our wallet is not our buy");

  const noSpend = parseSwapDelta(
    base({
      postTokenBalances: [
        { accountIndex: 1, mint: USDC_MINT, owner: PAYER, uiTokenAmount: { amount: "5000000", decimals: 6 } },
        { accountIndex: 2, mint: MINT, owner: PAYER, uiTokenAmount: { amount: "299330", decimals: 8 } },
      ],
    }),
    { payer: PAYER, mint: MINT },
  );
  assert.strictEqual(noSpend, null, "no USDC spent -> not a buy");

  const nullMeta: RpcParsedTx = { meta: null, transaction: { message: { accountKeys: [{ pubkey: PAYER }] } } };
  assert.strictEqual(parseSwapDelta(nullMeta, { payer: PAYER, mint: MINT }), null, "null meta -> null");
}

// ─── attemptMatches ─────────────────────────────────────────────────────────────────────────────────
{
  const d = { qtyBase: 299_330n, usdcOutMicro: 1_000_000n };
  assert.strictEqual(attemptMatches(d, { inAmountMicro: 1_000_000n, minOutBase: 297_834n }), true, "exact match passes");
  assert.strictEqual(attemptMatches(d, { inAmountMicro: 999_999n, minOutBase: 297_834n }), false, "spent more than signed -> reject");
  assert.strictEqual(attemptMatches(d, { inAmountMicro: 1_000_000n, minOutBase: 299_331n }), false, "received less than the minimum -> reject");
}

// ─── parseJupQuote ──────────────────────────────────────────────────────────────────────────────────
{
  const q = parseJupQuote({ inAmount: "1000000", outAmount: "299330", otherAmountThreshold: "297834", priceImpactPct: "0.01" });
  assert.deepStrictEqual(q, { inAmount: 1_000_000n, outAmount: 299_330n, minOutBase: 297_834n, priceImpactBp: 1 }, "parses a real quote");

  assert.strictEqual(parseJupQuote({ inAmount: "1000000", otherAmountThreshold: "297834" }), null, "missing outAmount -> null");
  assert.strictEqual(parseJupQuote({ inAmount: "0", outAmount: "1", otherAmountThreshold: "1" }), null, "zero inAmount -> null");
  assert.strictEqual(parseJupQuote(null), null, "null json -> null");

  const noImpact = parseJupQuote({ inAmount: "1000000", outAmount: "299330", otherAmountThreshold: "297834", priceImpactPct: 0 });
  assert.strictEqual(noImpact!.priceImpactBp, 0, "priceImpactPct 0 -> 0 bp");
}

// ─── decodeBase58 / sigBytesValid ───────────────────────────────────────────────────────────────────
{
  assert.deepStrictEqual(Array.from(decodeBase58("11")!), [0, 0], "'11' decodes to two zero bytes");
  assert.deepStrictEqual(Array.from(decodeBase58("2")!), [1], "'2' decodes to a single 0x01");
  assert.strictEqual(decodeBase58("0OIl"), null, "invalid base58 characters -> null");
  assert.strictEqual(decodeBase58(""), null, "empty string -> null");

  assert.strictEqual(
    sigBytesValid("5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW"),
    true,
    "a real 88-char signature is 64 bytes",
  );
  assert.strictEqual(sigBytesValid("abc"), false, "too short -> false");
  assert.strictEqual(sigBytesValid("0OIl"), false, "invalid characters -> false");
}

console.log("test-stocks: OK");
