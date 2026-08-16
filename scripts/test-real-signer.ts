// Verifies the device-signing boundary before real funds move: EIP-712 domain injection, BigInt-safe
// serialization, signature v normalization, and the "123n" wire form our own relay produces.
import assert from "node:assert/strict";
import { privySigner, rehydrateBigints } from "../src/lib/real-signer";

const ADDRESS = "0x0000000000000000000000000000000000000001";
const TO = "0x0000000000000000000000000000000000000002";
const VALID_HASH = `0x${"ab".repeat(32)}`;
const sig = (v: string) => `0x${"11".repeat(64)}${v}`;

type Call = { method: string; params?: unknown[] };

function fakeProvider(responses: unknown[]) {
  const calls: Call[] = [];
  let next = 0;
  return {
    calls,
    provider: {
      async request(args: Call): Promise<unknown> {
        calls.push(args);
        if (next >= responses.length) throw new Error(`unexpected provider request: ${args.method}`);
        return responses[next++];
      },
    },
  };
}

const testSigner = (provider: { request(args: Call): Promise<unknown> }) =>
  privySigner({ address: ADDRESS, getEthereumProvider: async () => provider });

const sentPayload = (calls: Call[]) =>
  JSON.parse(calls[0].params![1] as string) as { types: Record<string, unknown>; message: Record<string, unknown> };

async function main() {
  // 1 — a wrong domain field set changes the domain separator, so the exchange recovers a different
  // address and rejects the order as unsigned.
  {
    const { calls, provider } = fakeProvider([sig("1b")]);
    await testSigner(provider).signTypedData({
      domain: { name: "HedgeFun", chainId: 137, verifyingContract: "0x0000000000000000000000000000000000000003" },
      types: { Order: [{ name: "amount", type: "uint256" }] },
      primaryType: "Order",
      message: {},
    });
    assert.deepStrictEqual(sentPayload(calls).types.EIP712Domain, [
      { name: "name", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ]);
  }

  // 2 — a caller-supplied EIP712Domain is authoritative; overwriting it signs a struct nobody asked for.
  {
    const { calls, provider } = fakeProvider([sig("1b")]);
    const supplied = [{ name: "version", type: "string" }];
    await testSigner(provider).signTypedData({
      domain: { name: "x" },
      types: { EIP712Domain: supplied, Order: [] },
      primaryType: "Order",
      message: {},
    });
    assert.deepStrictEqual(sentPayload(calls).types.EIP712Domain, supplied);
  }

  // 3 — JSON.stringify throws on BigInt: without the replacer every order with an amount dies here.
  {
    const { calls, provider } = fakeProvider([sig("1b")]);
    await testSigner(provider).signTypedData({
      domain: { chainId: 1 },
      types: { Order: [] },
      primaryType: "Order",
      message: { amount: 123456789012345678901234567890n, nested: { ok: true, count: 2n } },
    });
    const message = sentPayload(calls).message as { amount: string; nested: { count: string } };
    assert.strictEqual(message.amount, "123456789012345678901234567890");
    assert.strictEqual(message.nested.count, "2");
  }

  // 4 — v=00/01 recovers a different address; the exchange calls that an invalid signature and never
  // says why. Canonical values must pass through byte-identical.
  {
    const { provider } = fakeProvider([sig("00")]);
    assert.strictEqual(await testSigner(provider).signMessage("0x01"), sig("1b"));
  }
  {
    const { provider } = fakeProvider([sig("01")]);
    assert.strictEqual(await testSigner(provider).signMessage("0x01"), sig("1c"));
  }
  {
    const canonical = sig("1b");
    const { provider } = fakeProvider([canonical]);
    assert.strictEqual(await testSigner(provider).signMessage("0x01"), canonical);
  }
  {
    const { provider } = fakeProvider(["0x1234"]);
    await assert.rejects(testSigner(provider).signMessage("0x01"), /malformed signature/);
  }
  {
    const { provider } = fakeProvider([sig("05")]);
    await assert.rejects(testSigner(provider).signMessage("0x01"), /unrecognised signature v byte/);
  }

  // 5 — personal_sign takes [message, address]; swapping them signs a different preimage silently.
  {
    const { calls, provider } = fakeProvider([sig("1b")]);
    await testSigner(provider).signMessage("0xdeadbeef");
    assert.deepStrictEqual(calls[0].params, ["0xdeadbeef", ADDRESS]);
  }

  // 6 — an absent value must stay absent (some providers treat 0x0 differently), and a BigInt value
  // must reach the provider hex-encoded, not as a decimal string.
  {
    const { calls, provider } = fakeProvider([VALID_HASH]);
    await testSigner(provider).sendTransaction({ chainId: 137, to: TO, data: "0x1234" });
    assert.deepStrictEqual(calls[0].params, [{ from: ADDRESS, to: TO, data: "0x1234" }]);
  }
  {
    const { calls, provider } = fakeProvider([VALID_HASH]);
    await testSigner(provider).sendTransaction({ chainId: 137, to: TO, data: "0x1234", value: 255n });
    assert.deepStrictEqual(calls[0].params, [{ from: ADDRESS, to: TO, data: "0x1234", value: "0xff" }]);
  }
  {
    const { provider } = fakeProvider(["0x123"]);
    await assert.rejects(testSigner(provider).sendTransaction({ chainId: 137, to: TO }), /malformed transaction hash/);
  }

  // 7 — a null receipt means "not mined yet": ending the wait there would report an unmined
  // transaction as settled. A 0x0 receipt is a revert, never a success.
  {
    const { calls, provider } = fakeProvider([VALID_HASH, null, { status: "0x1" }]);
    const handle = await testSigner(provider).sendTransaction({ chainId: 137, to: TO });
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((cb: () => void) => {
      cb();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    try {
      assert.deepStrictEqual(await handle.wait(), { transactionHash: VALID_HASH, transactionId: null });
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    assert.strictEqual(calls.filter((c) => c.method === "eth_getTransactionReceipt").length, 2);
  }
  {
    const { provider } = fakeProvider([VALID_HASH, { status: "0x0" }]);
    const handle = await testSigner(provider).sendTransaction({ chainId: 137, to: TO });
    await assert.rejects(handle.wait(), /transaction reverted/);
  }

  // 8 — our relay serializes BigInt as "123n"; signing that literal in a uint256 field either throws
  // in the wallet or signs a different struct. Everything that is not that exact form is untouched.
  {
    assert.strictEqual(rehydrateBigints("123n"), "123");
    assert.strictEqual(rehydrateBigints("-5n"), "-5");
    assert.deepStrictEqual(rehydrateBigints({ a: ["1n", "abcn", 2, null, true], b: { c: "12n3", d: "-7n" } }), {
      a: ["1", "abcn", 2, null, true],
      b: { c: "12n3", d: "-7" },
    });
    assert.strictEqual(rehydrateBigints(42), 42);
    assert.strictEqual(rehydrateBigints(null), null);
    assert.strictEqual(rehydrateBigints(true), true);
  }

  console.log("test-real-signer: OK");
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
