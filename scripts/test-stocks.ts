// DB-free self-check for the tokenized-stocks PURE core (src/lib/stocks.ts). Same style as
// scripts/test-hedge-cores.ts — node:assert, no framework, no DB, no network.
// Run: npx tsx scripts/test-stocks.ts
import assert from "node:assert";
import {
  xstockToAsset,
  priceFieldsFrom,
  isDeckEligible,
  isTradable,
  deckRank,
  qtyBaseFor,
  valueCents,
  entryPriceCents,
  usdcMicroToCents,
  livePnlCents,
  uiQty,
  parseSwapDelta,
  parseSellDelta,
  attemptMatches,
  sellMatches,
  usdcMicroToCentsFloor,
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
    { priceCents: 33416, change24hBp: 94, liquidityCents: 85168162, mcapMillions: null, decimals: 8, uiMultiplierMicro: 1002664 },
    "real Jupiter entry maps to the persisted fields",
  );

  assert.strictEqual(priceFieldsFrom({ usdPrice: 0 }), null, "usdPrice 0 -> null");
  assert.strictEqual(priceFieldsFrom(undefined), null, "undefined entry -> null");
  assert.strictEqual(priceFieldsFrom({}), null, "no usdPrice -> null");

  // DALx today: no Solana pool yet, so Jupiter carries only the issuer's reference price.
  const refOnly = priceFieldsFrom({ decimals: 8, stockData: { price: 79.58, mcap: 5.2e10, updatedAt: "2026-09-14T17:20:46.79Z" } });
  assert.deepStrictEqual(
    refOnly,
    { priceCents: 7958, change24hBp: null, liquidityCents: null, mcapMillions: 52000, decimals: 8, uiMultiplierMicro: null },
    "reference price only -> priced, no liquidity, market cap in millions",
  );
  assert.strictEqual(isTradable({ halted: false, liquidityCents: null }), false, "reference-only asset is paper-only");
  assert.strictEqual(priceFieldsFrom({ usdPrice: 80.1, stockData: { price: 79.58 } })!.priceCents, 8010, "DEX price wins over the reference price");
  assert.strictEqual(priceFieldsFrom({ usdPrice: 1, stockData: { mcap: 1e16 } })!.mcapMillions, 2_147_483_647, "mcap saturates at INT4 max");

  const huge = priceFieldsFrom({ usdPrice: 1, liquidity: 1e12 });
  assert.strictEqual(huge!.liquidityCents, 2_147_483_647, "liquidity saturates at INT4 max");

  const noMult = priceFieldsFrom({ usdPrice: 1 });
  assert.strictEqual(noMult!.uiMultiplierMicro, null, "no scaledUiConfig -> null multiplier");
  assert.strictEqual(noMult!.decimals, 8, "decimals defaults to 8");
  assert.strictEqual(noMult!.change24hBp, null, "no priceChange24h -> null");
}

// ─── isDeckEligible / isTradable / deckRank ─────────────────────────────────────────────────────────
{
  assert.strictEqual(isDeckEligible({ halted: false, priceCents: 100 }), true, "priced + not halted is eligible");
  assert.strictEqual(isDeckEligible({ halted: true, priceCents: 100 }), false, "halted -> not eligible");
  assert.strictEqual(isDeckEligible({ halted: false, priceCents: null }), false, "unpriced -> not eligible");
  assert.strictEqual(isTradable({ halted: false, liquidityCents: 100_000 }), true, "at the liquidity floor is tradable");
  assert.strictEqual(isTradable({ halted: false, liquidityCents: 99_999 }), false, "below the floor is paper-only");
  assert.strictEqual(isTradable({ halted: true, liquidityCents: 9_999_999 }), false, "halted is never tradable");
  const ranked = [
    { s: "ref-big", liquidityCents: null, mcapMillions: 5_000_000 },
    { s: "liq-small", liquidityCents: 1_000, mcapMillions: 10 },
    { s: "ref-small", liquidityCents: null, mcapMillions: 100 },
    { s: "liq-big", liquidityCents: 900_000, mcapMillions: null },
  ].sort(deckRank).map((x) => x.s);
  assert.deepStrictEqual(ranked, ["liq-big", "liq-small", "ref-big", "ref-small"], "liquidity first (nulls last), then market cap");
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

// ─── parseSwapDelta / parseSellDelta under FEE SPONSORSHIP ──────────────────────────────────────────
// The fee payer is the sponsor now, so the buyer is no longer accountKeys[0] — but must still SIGN.
{
  const PAYER = "PayerPubkey111";
  const SPONSOR = "SponsorPubkey111";
  const MINT = "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp";
  const buy = (keys: { pubkey: string; signer?: boolean }[]): RpcParsedTx => ({
    meta: {
      err: null,
      preTokenBalances: [{ accountIndex: 1, mint: USDC_MINT, owner: PAYER, uiTokenAmount: { amount: "5000000", decimals: 6 } }],
      postTokenBalances: [
        { accountIndex: 1, mint: USDC_MINT, owner: PAYER, uiTokenAmount: { amount: "4000000", decimals: 6 } },
        { accountIndex: 2, mint: MINT, owner: PAYER, uiTokenAmount: { amount: "299330", decimals: 8 } },
      ],
    },
    transaction: { message: { accountKeys: keys } },
  });

  const sponsored = parseSwapDelta(buy([{ pubkey: SPONSOR, signer: true }, { pubkey: PAYER, signer: true }]), {
    payer: PAYER,
    mint: MINT,
  });
  assert.deepStrictEqual(sponsored, { qtyBase: 299_330n, usdcOutMicro: 1_000_000n }, "payer is a signer but not key 0 -> still our buy");

  const notSigner = parseSwapDelta(buy([{ pubkey: SPONSOR, signer: true }, { pubkey: PAYER, signer: false }]), {
    payer: PAYER,
    mint: MINT,
  });
  assert.strictEqual(notSigner, null, "payer present but NOT a signer -> not our buy");

  // The same tx read from the other end: the stock leaves, USDC arrives.
  const sell = (over: Partial<NonNullable<RpcParsedTx["meta"]>> = {}): RpcParsedTx => ({
    meta: {
      err: null,
      preTokenBalances: [
        { accountIndex: 1, mint: USDC_MINT, owner: PAYER, uiTokenAmount: { amount: "4000000", decimals: 6 } },
        { accountIndex: 2, mint: MINT, owner: PAYER, uiTokenAmount: { amount: "299330", decimals: 8 } },
      ],
      // The emptied token account is CLOSED in the same tx, so it is absent from postTokenBalances.
      postTokenBalances: [
        { accountIndex: 1, mint: USDC_MINT, owner: PAYER, uiTokenAmount: { amount: "5010000", decimals: 6 } },
      ],
      ...over,
    },
    transaction: { message: { accountKeys: [{ pubkey: SPONSOR, signer: true }, { pubkey: PAYER, signer: true }] } },
  });

  assert.deepStrictEqual(
    parseSellDelta(sell(), { payer: PAYER, mint: MINT }),
    { qtyBase: 299_330n, usdcInMicro: 1_010_000n },
    "reads the stock sold and the USDC received (closed account = zero post balance)",
  );
  assert.strictEqual(parseSellDelta(buy([{ pubkey: PAYER, signer: true }]), { payer: PAYER, mint: MINT }), null, "a BUY is not a sell");
  assert.strictEqual(parseSwapDelta(sell(), { payer: PAYER, mint: MINT }), null, "a SELL is not a buy");
  assert.strictEqual(
    parseSellDelta(sell({ err: { InstructionError: [0, "Custom"] } }), { payer: PAYER, mint: MINT }),
    null,
    "a failed sell closes nothing",
  );
}

// ─── sellMatches ────────────────────────────────────────────────────────────────────────────────────
{
  const d = { qtyBase: 299_330n, usdcInMicro: 1_010_000n };
  assert.strictEqual(sellMatches(d, { inAmountBase: 299_330n, minOutMicro: 1_000_000n }), true, "exact lot, above the minimum -> match");
  assert.strictEqual(sellMatches(d, { inAmountBase: 299_329n, minOutMicro: 1_000_000n }), false, "sold MORE stock than signed -> reject");
  assert.strictEqual(sellMatches(d, { inAmountBase: 299_330n, minOutMicro: 1_010_001n }), false, "received less USDC than the minimum -> reject");
}

// ─── usdcMicroToCentsFloor: proceeds floor vs cost ceil ─────────────────────────────────────────────
{
  assert.strictEqual(usdcMicroToCentsFloor(1_009_999n), 100, "proceeds FLOOR (cost would ceil to 101)");
  assert.strictEqual(usdcMicroToCents(1_009_999n), 101, "a cost basis still ceils");
  assert.strictEqual(usdcMicroToCentsFloor(0n), 0);
  assert.strictEqual(usdcMicroToCentsFloor(-5n), 0, "a negative reads as nothing, never as a debt");
}

// ─── sponsor.ts: the pure pieces of the fee-sponsored builder ───────────────────────────────────────
// Everything here is arithmetic on bytes — no network, no key material beyond a throwaway keypair.
async function sponsorChecks() {
  const { patchAtaPayer, decodeLookupTable, messageHashOf, closeAccountIx, ATA_PROGRAM } = await import("../src/lib/sponsor");
  const kit = await import("@solana/kit");
  const { generateKeyPairSync } = await import("node:crypto");

  // patchAtaPayer: ONLY the Associated-Token program's funding account (index 0) moves.
  {
    const USER = "6dNVeTv6yzcYiRhRPfCnJfRQmUMKFJqPmPJcaNBRCGFT";
    const SPONSOR = "GavgGKU9N3V1WjKLwQr3tapuXCCLFeJEeQpV6Bgq9rGf";
    const ata = {
      programId: ATA_PROGRAM,
      accounts: [
        { pubkey: USER, isSigner: true, isWritable: true },
        { pubkey: "Ch4K4D2cTVNY7H7nJ2Y6byCiEeQzkE3AmGvJb1knYbTc", isSigner: false, isWritable: true },
        { pubkey: USER, isSigner: false, isWritable: false },
      ],
      data: "AA==",
    };
    const swap = {
      programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
      accounts: [{ pubkey: USER, isSigner: true, isWritable: true }],
      data: "AQ==",
    };
    const [patchedAta, patchedSwap] = patchAtaPayer([ata, swap], SPONSOR);
    assert.strictEqual(patchedAta.accounts[0].pubkey, SPONSOR, "the ATA funding payer becomes the sponsor");
    assert.strictEqual(patchedAta.accounts[0].isSigner, true, "its roles are untouched");
    assert.strictEqual(patchedAta.accounts[0].isWritable, true);
    assert.strictEqual(patchedAta.accounts[2].pubkey, USER, "the OWNER account is not touched");
    assert.deepStrictEqual(patchedSwap, swap, "a non-ATA instruction is left alone");
    assert.strictEqual(ata.accounts[0].pubkey, USER, "the input instruction is not mutated");
  }

  // decodeLookupTable: 56-byte header, then packed 32-byte addresses.
  {
    const b58 = kit.getBase58Decoder();
    const a1 = new Uint8Array(32).fill(1);
    const a2 = new Uint8Array(32).fill(2);
    const buf = new Uint8Array(56 + 64);
    buf.set(a1, 56);
    buf.set(a2, 88);
    assert.deepStrictEqual(decodeLookupTable(buf), [b58.decode(a1), b58.decode(a2)], "two addresses past the header");
    assert.deepStrictEqual(decodeLookupTable(new Uint8Array(56)), [], "a header-only table has no addresses");
    const ragged = new Uint8Array(56 + 40);
    ragged.set(a1, 56);
    assert.deepStrictEqual(decodeLookupTable(ragged), [b58.decode(a1)], "a truncated tail is ignored, not guessed");
  }

  // closeAccountIx: the SPL-Token CloseAccount shape verified live in Jupiter's own cleanup ix.
  {
    const ix = closeAccountIx({ tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", account: "A", destination: "B", owner: "C" });
    assert.deepStrictEqual(Array.from(Buffer.from(ix.data, "base64")), [9], "opcode 9 = CloseAccount");
    assert.deepStrictEqual(
      ix.accounts.map((a) => [a.pubkey, a.isSigner, a.isWritable]),
      [["A", false, true], ["B", false, true], ["C", true, false]],
      "account(w), destination(w), owner(signer)",
    );
  }

  // messageHashOf: the hash is over the MESSAGE, so signing must not move it.
  {
    const keypair64 = () => {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const sk = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
      const pk = publicKey.export({ format: "der", type: "spki" }) as Buffer;
      return Uint8Array.from(Buffer.concat([sk.subarray(sk.length - 32), pk.subarray(pk.length - 32)]));
    };
    const sponsor = await kit.createKeyPairSignerFromBytes(keypair64());
    const user = await kit.createKeyPairSignerFromBytes(keypair64());
    // SetComputeUnitLimit(1_400_000) — hand-built, so the test needs no program client.
    const cuLimit = {
      programAddress: kit.address("ComputeBudget111111111111111111111111111111"),
      accounts: [],
      data: new Uint8Array([2, 0xc0, 0x5c, 0x15, 0x00]),
    };
    // One instruction the USER must sign, so the tx has both signature slots a real swap has.
    const userIx = {
      programAddress: kit.address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
      accounts: [{ address: user.address, role: kit.AccountRole.READONLY_SIGNER }],
      data: new Uint8Array([1]),
    };
    const message = kit.pipe(
      kit.createTransactionMessage({ version: 0 }),
      (m) => kit.setTransactionMessageFeePayer(sponsor.address, m),
      (m) =>
        kit.setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: kit.getBase58Decoder().decode(new Uint8Array(32).fill(7)) as never, lastValidBlockHeight: 1_000n },
          m,
        ),
      (m) => kit.appendTransactionMessageInstructions([cuLimit, userIx], m),
    );
    const compiled = kit.compileTransaction(message);
    const wire = new Uint8Array(kit.getTransactionEncoder().encode(compiled));
    const unsignedHash = messageHashOf(wire);
    assert.strictEqual(unsignedHash.length, 64, "sha256 hex");
    assert.deepStrictEqual(
      Object.values(kit.getTransactionDecoder().decode(wire).signatures),
      [null, null],
      "an unsigned tx has empty signature slots",
    );

    const signed = await kit.partiallySignTransaction([user.keyPair], kit.getTransactionDecoder().decode(wire));
    const signedWire = new Uint8Array(kit.getTransactionEncoder().encode(signed));
    assert.strictEqual(messageHashOf(signedWire), unsignedHash, "the user's signature does not move the message hash");
    const slots = kit.getTransactionDecoder().decode(signedWire).signatures as Record<string, Uint8Array | null>;
    assert.strictEqual(slots[sponsor.address], null, "the sponsor slot is still open");
    assert.strictEqual(slots[user.address]?.length, 64, "the user slot is filled with 64 bytes");
  }
}

sponsorChecks()
  .then(() => console.log("test-stocks: OK"))
  .catch((e) => {
    console.error("FAIL:", e);
    process.exitCode = 1;
  });

