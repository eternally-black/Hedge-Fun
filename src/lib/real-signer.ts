"use client";

// The D5 boundary: a Privy embedded EVM wallet adapted to the Polymarket SDK's `Signer`. Every
// signature the real-money path needs — order EIP-712, gasless relay payloads, L1 cred derivation —
// is produced HERE, in the device, and nowhere else; the server holds a refusing stub instead
// (src/lib/polymarket-server.ts). Wallet quirks that would otherwise surface as an unexplained
// "invalid signature" from the CLOB are normalized in one place: see the three traps below.
export type Eip1193Provider = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };
export type EvmWalletLike = { address: string; getEthereumProvider(): Promise<Eip1193Provider> };

// Structural, not the SDK's branded `Signer`: branding would leak EvmAddress/EvmSignature through
// every caller and make this module untestable without loading the SDK (tsx cannot import its root).
// The single cast to the SDK's shape happens where the client is constructed.
export type TransactionHandle = {
  readonly transactionHash: string | null;
  readonly transactionId: string | null;
  wait(): Promise<{ transactionHash: string; transactionId: string | null }>;
};
export type Signer = {
  getAddress(): Promise<string>;
  signTypedData(payload: TypedDataPayload): Promise<string>;
  signMessage(message: string): Promise<string>;
  sendTransaction(request: { chainId: number; to: string; data?: string; value?: bigint }): Promise<TransactionHandle>;
};

type TypedDataField = { name: string; type: string };
export type TypedDataPayload = {
  domain: { chainId?: number; name?: string; salt?: string; verifyingContract?: string; version?: string };
  types: Record<string, readonly TypedDataField[]>;
  primaryType: string;
  message: Record<string, unknown>;
};

// Canonical EIP-712 field order. Only the keys actually present in the domain are declared —
// declaring an absent field changes the domain separator and thus the recovered address.
const DOMAIN_FIELDS: ReadonlyArray<[keyof TypedDataPayload["domain"], string]> = [
  ["name", "string"],
  ["version", "string"],
  ["chainId", "uint256"],
  ["verifyingContract", "address"],
  ["salt", "bytes32"],
];

// TRAP: JSON.stringify throws on BigInt, and the SDK's typed-data messages carry BigInt amounts.
function bigintSafe(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

// TRAP: some wallets return `v` as 00/01 instead of 1b/1c. A wrong v byte makes ecrecover return a
// DIFFERENT address, so the exchange rejects the order as an invalid signature — no error anywhere
// near the actual cause. Normalize at the only place signatures are produced.
function normalizeSignature(raw: unknown): string {
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(raw)) {
    throw new Error("signer returned a malformed signature");
  }
  const v = Number.parseInt(raw.slice(-2), 16);
  if (v === 27 || v === 28) return raw;
  if (v === 0 || v === 1) return `${raw.slice(0, -2)}${(v + 27).toString(16)}`;
  throw new Error(`signer returned an unrecognised signature v byte: ${v}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// TRAP: our own server serializes relay requests through `safeJson`, which renders BigInt as "123n"
// so the durable audit round-trips losslessly. A wallet handed "123n" for a uint256 field either
// throws or signs a different struct — undo it before signing, and touch nothing else.
export function rehydrateBigints(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rehydrateBigints);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rehydrateBigints(v)]));
  }
  if (typeof value === "string" && /^-?\d+n$/.test(value)) return value.slice(0, -1);
  return value;
}

export function privySigner(wallet: EvmWalletLike): Signer {
  let cached: Eip1193Provider | null = null;
  const provider = async () => (cached ??= await wallet.getEthereumProvider());

  const signer = {
    // Not re-cased: the server compares case-insensitively, and re-casing an address by hand is how
    // EIP-55 checksum mismatches start.
    getAddress: async () => wallet.address,

    signTypedData: async (payload: TypedDataPayload) => {
      const types = { ...payload.types };
      if (!types.EIP712Domain) {
        types.EIP712Domain = DOMAIN_FIELDS.filter(([key]) => payload.domain[key] !== undefined).map(
          ([name, type]) => ({ name, type }),
        );
      }
      const raw = await (await provider()).request({
        method: "eth_signTypedData_v4",
        params: [
          wallet.address,
          JSON.stringify(
            { domain: payload.domain, types, primaryType: payload.primaryType, message: payload.message },
            bigintSafe,
          ),
        ],
      });
      return normalizeSignature(raw);
    },

    // The message is already a hex digest — passing it through unchanged is the contract; re-encoding
    // it would sign a different preimage.
    signMessage: async (message: string) => {
      const raw = await (await provider()).request({ method: "personal_sign", params: [message, wallet.address] });
      return normalizeSignature(raw);
    },

    // No chain switching here: a silent network switch under a signature prompt is how a user signs
    // on the wrong chain. The caller owns chain selection.
    sendTransaction: async (request: { chainId: number; to: string; data?: string; value?: bigint }) => {
      const tx: Record<string, unknown> = { from: wallet.address, to: request.to };
      if (request.data !== undefined) tx.data = request.data;
      if (request.value !== undefined) tx.value = `0x${request.value.toString(16)}`; // absent ≠ 0x0 for some providers
      const hash = await (await provider()).request({ method: "eth_sendTransaction", params: [tx] });
      if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
        throw new Error("signer returned a malformed transaction hash");
      }

      const handle: TransactionHandle = {
        transactionHash: hash,
        transactionId: null, // direct chain send; relayer-submitted transactions carry an id, these do not
        wait: async () => {
          for (let i = 0; i < 90; i++) {
            const receipt = (await (await provider()).request({
              method: "eth_getTransactionReceipt",
              params: [hash],
            })) as { status?: string } | null;
            if (receipt && typeof receipt.status === "string") {
              if (receipt.status === "0x0") throw new Error(`transaction reverted: ${hash}`);
              return { transactionHash: hash, transactionId: null };
            }
            await sleep(2000);
          }
          throw new Error(`timed out waiting for ${hash}`);
        },
      };
      return handle;
    },
  };

  return signer;
}
