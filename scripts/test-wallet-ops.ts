// scripts/test-wallet-ops.ts — wrap calldata pinned byte-for-byte against the recorded production
// transaction (poly-spike wrap.mjs --check fixture, tx 0x451fe401…c56406). A wrong ABI guess here
// would otherwise only surface as a relayer rejection with real money in flight.
import assert from "node:assert";
import { buildWrapCalls, COLLATERAL_ONRAMP } from "../src/lib/wallet-ops";
import { USDCE_ADDRESS } from "../src/lib/polygon";

async function main() {
  const wallet = "0x0b699a09e593bff83ec0d9b97291a75b400bf2a9";
  const amount = 2_000_000n;
  const calls = buildWrapCalls(wallet, amount);

  // call[0]: USDC.e.approve(CollateralOnramp, amount)
  assert.strictEqual(calls[0].to, USDCE_ADDRESS);
  assert.strictEqual(
    calls[0].data,
    "0x095ea7b300000000000000000000000093070a847efef7f70739046a929d47a521f5b8ee00000000000000000000000000000000000000000000000000000000001e8480",
  );

  // call[1]: CollateralOnramp.wrap(USDC.e, wallet, amount)
  assert.strictEqual(calls[1].to, COLLATERAL_ONRAMP);
  assert.strictEqual(
    calls[1].data,
    "0x623556380000000000000000000000002791bca1f2de4661ed88a30c99a7a9449aa841740000000000000000000000000b699a09e593bff83ec0d9b97291a75b400bf2a900000000000000000000000000000000000000000000000000000000001e8480",
  );

  // Checksummed (mixed-case) wallet input produces identical bytes.
  const checksummed = "0x0B699A09e593bFf83eC0d9B97291A75b400bF2a9";
  assert.deepStrictEqual(buildWrapCalls(checksummed, amount), calls);

  // Amount 0n: the amount word (last 32 bytes) is all zeros; address words stay intact.
  const zeroCalls = buildWrapCalls(wallet, 0n);
  assert.ok(zeroCalls[0].data.endsWith("0".repeat(64)), "approve amount word zero");
  assert.strictEqual(zeroCalls[0].data.slice(0, 10 + 64), calls[0].data.slice(0, 10 + 64), "approve selector+spender intact");
  assert.ok(zeroCalls[1].data.endsWith("0".repeat(64)), "wrap amount word zero");
  assert.strictEqual(zeroCalls[1].data.slice(0, 10 + 128), calls[1].data.slice(0, 10 + 128), "wrap selector+addresses intact");

  console.log("OK: wallet-ops calldata matches the recorded production fixture byte for byte");
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
