// scripts/test-wallet-ops.ts — wrap calldata pinned byte-for-byte against the recorded production
// transaction (poly-spike wrap.mjs --check fixture, tx 0x451fe401…c56406). A wrong ABI guess here
// would otherwise only surface as a relayer rejection with real money in flight.
import assert from "node:assert";
import {
  COLLATERAL_ADAPTER,
  NEG_RISK_COLLATERAL_ADAPTER,
  buildWrapCalls,
  buildApprovalCalls,
  COLLATERAL_ONRAMP,
  AUTO_REDEEM_OPERATOR,
  CTF_EXCHANGE,
  NEGRISK_CTF_EXCHANGE,
  CONDITIONAL_TOKENS,
} from "../src/lib/wallet-ops";
import { USDCE_ADDRESS, PUSD_ADDRESS } from "../src/lib/polygon";
import { REQUIRED_APPROVALS } from "../src/lib/trading-ready";

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

  // Approval set: byte-pin the EXACT nine calls (the higher-blast-radius output — a wrong ABI or
  // address here surfaces as MAX_UINT granted to the wrong contract). Exchange addresses were
  // externally verified against PolygonScan labels in the S4 review round; the two collateral adapters (normal and neg-risk) come from the SDK's own production environment config and is what PERFORMS a redemption.
  const approvals = buildApprovalCalls();
  assert.strictEqual(approvals.length, 9, "exactly nine calls, nothing more");
  const MAX = "f".repeat(64);
  const pad = (a: string) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  assert.deepStrictEqual(
    approvals.map((c) => [c.to, c.data]),
    [
      [PUSD_ADDRESS, "0x095ea7b3" + pad(CTF_EXCHANGE) + MAX],
      [PUSD_ADDRESS, "0x095ea7b3" + pad(NEGRISK_CTF_EXCHANGE) + MAX],
      [CONDITIONAL_TOKENS, "0xa22cb465" + pad(CTF_EXCHANGE) + "1".padStart(64, "0")],
      [CONDITIONAL_TOKENS, "0xa22cb465" + pad(NEGRISK_CTF_EXCHANGE) + "1".padStart(64, "0")],
      [PUSD_ADDRESS, "0x095ea7b3" + pad(COLLATERAL_ADAPTER) + MAX],
      [CONDITIONAL_TOKENS, "0xa22cb465" + pad(COLLATERAL_ADAPTER) + "1".padStart(64, "0")],
      [PUSD_ADDRESS, "0x095ea7b3" + pad(NEG_RISK_COLLATERAL_ADAPTER) + MAX],
      [CONDITIONAL_TOKENS, "0xa22cb465" + pad(NEG_RISK_COLLATERAL_ADAPTER) + "1".padStart(64, "0")],
      // The auto-redeemer: without this operator right a won market leaves the payout sitting as
      // an unredeemed position. It is in Polymarket's own required set and rides the same batch.
      [CONDITIONAL_TOKENS, "0xa22cb465" + pad(AUTO_REDEEM_OPERATOR) + "1".padStart(64, "0")],
    ],
    "approval calldata pinned byte for byte",
  );

  // The readiness gate and the batch must describe the SAME nine grants. A gate that checks less
  // calls a half-approved wallet ready and hands the exchange an order it will refuse; a gate that
  // checks more blocks trading on a grant nothing ever makes. Comparing (token, target) pairs is
  // what keeps the two files honest — they are edited months apart, by different reasons.
  const granted = approvals.map((c) => [c.to.toLowerCase(), "0x" + c.data.slice(34, 74)].join("|")).sort();
  const checked = REQUIRED_APPROVALS.map((a) => [a.token.toLowerCase(), a.target.toLowerCase()].join("|")).sort();
  assert.deepStrictEqual(checked, granted, "the readiness check covers exactly what the batch grants");

  console.log("OK: wallet-ops calldata matches the recorded production fixture byte for byte");
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
