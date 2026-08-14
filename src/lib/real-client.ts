"use client";

// Browser-side orchestrator for the real-money paths: it owns the Polymarket SecureClient, the
// provisioning flow, the signature relay and the order flow. Every signature comes from the device
// through privySigner (D5) — the server relays requests and validates results, it never signs.
// React-free on purpose: the screen calls these, and so can a harness.
import { createSecureClient, remoteBuilderSigning, OrderSide } from "@polymarket/client";
import { isWalletDeployed, deployDepositWallet, prepareMarketOrder } from "@polymarket/client/actions";
import { privySigner, rehydrateBigints, type EvmWalletLike } from "./real-signer";

export type Api = (path: string, init?: RequestInit) => Promise<unknown>;
export type RealCtx = {
  wallet: EvmWalletLike;
  depositWalletAddress?: string | null;
  // The SDK fetches /api/builder/sign itself, outside our `api` wrapper, so it needs its own way to
  // present the Privy bearer token — our routes authenticate on the header, never on a cookie.
  getToken: () => Promise<string | null>;
};

type SecureClient = Awaited<ReturnType<typeof createSecureClient>>;

// Constructing a client derives L2 CLOB creds from an L1 signature, i.e. it costs a DEVICE PROMPT.
// Memoized per (EOA, deposit wallet) so a session pays that once. The creds are deliberately not
// cached in the browser — they live server-side encrypted, and localStorage would hand them to any
// XSS. The first ctx's getToken wins for the lifetime of the entry; one signed-in user per tab.
const clientCache = new Map<string, SecureClient>();

export async function getRealClient(ctx: RealCtx): Promise<SecureClient> {
  const key = `${ctx.wallet.address.toLowerCase()}:${ctx.depositWalletAddress ?? ""}`;
  const cached = clientCache.get(key);
  if (cached) return cached;

  const client = await createSecureClient({
    signer: privySigner(ctx.wallet),
    wallet: ctx.depositWalletAddress ?? undefined,
    apiKey: remoteBuilderSigning({
      url: "/api/builder/sign",
      credentials: "same-origin",
      headers: async (): Promise<Record<string, string>> => {
        const token = await ctx.getToken();
        return token ? { authorization: `Bearer ${token}` } : {};
      },
    }),
  } as Parameters<typeof createSecureClient>[0]);
  clientCache.set(key, client);
  return client;
}

export async function provisionReal(api: Api, ctx: RealCtx): Promise<{ depositWalletAddress: string }> {
  const client = await getRealClient(ctx);

  if (!(await isWalletDeployed(client))) {
    const handle = await deployDepositWallet(client);
    await handle.wait();
  }

  // AccountIdentity: `wallet` is the deposit wallet, `signer` the embedded EOA. The server re-checks
  // owner() on chain before it binds this address to the user.
  const depositWalletAddress = client.account.wallet;
  await api("/api/real/wallet", { method: "POST", body: JSON.stringify({ depositWalletAddress }) });

  const creds = client.credentials;
  await api("/api/real/creds", {
    method: "POST",
    body: JSON.stringify({ key: creds.key, secret: creds.secret, passphrase: creds.passphrase }),
  });

  return { depositWalletAddress };
}

export type WorkflowKind = "APPROVALS" | "WRAP" | "REDEEM" | "WITHDRAW";
export type WorkflowOutcome =
  | { status: "done" }
  | { status: "submitting"; transactionId: string | null }
  | { status: "failed"; error: string };

type WorkflowResponse =
  | { status: "pending_signature"; runId: string; requestHash: string; request: unknown }
  | { status: "submitting"; transactionId: string | null }
  | { status: "done" }
  | { status: "failed"; error: string }
  | { status: "stale" };

export async function runRealWorkflow(
  api: Api,
  ctx: RealCtx,
  kind: WorkflowKind,
  onStep?: (note: string) => void,
): Promise<WorkflowOutcome> {
  // No SecureClient here: the relay needs signatures, not CLOB creds, and constructing one would
  // cost an extra device prompt for nothing.
  const signer = privySigner(ctx.wallet);
  let answer: { runId: string; requestHash: string; signature: string } | undefined;
  let restarts = 0;
  let step = 0;

  // Bounded: a server that keeps yielding must not be able to prompt the device forever.
  for (let i = 0; i < 12; i++) {
    const response = (await api("/api/real/workflow", {
      method: "POST",
      body: JSON.stringify(answer ? { kind, answer } : { kind }),
    })) as WorkflowResponse;
    answer = undefined;

    switch (response.status) {
      case "pending_signature": {
        const request = response.request as { kind?: unknown; payload?: unknown };
        let signature: string;
        switch (request.kind) {
          case "signGaslessTypedData":
            signature = await signer.signTypedData(rehydrateBigints(request.payload) as never);
            break;
          case "signGaslessMessage":
            signature = await signer.signMessage(rehydrateBigints(request.payload) as never);
            break;
          case "requestAddress":
            // The engine answers these server-side; seeing one means it changed under us.
            throw new Error("relay asked the device for an address");
          default:
            throw new Error(`unknown workflow request kind: ${String(request.kind)}`);
        }
        answer = { runId: response.runId, requestHash: response.requestHash, signature };
        onStep?.(`signed step ${++step}`);
        continue;
      }
      case "stale":
        if (restarts++ >= 2) return { status: "failed", error: "workflow_stale" };
        onStep?.("run went stale — restarting");
        continue;
      case "submitting":
        onStep?.("submitted to the relayer");
        return { status: "submitting", transactionId: response.transactionId ?? null };
      case "done":
        return { status: "done" };
      case "failed":
        return { status: "failed", error: response.error };
      default:
        throw new Error(`unexpected workflow status: ${String((response as { status?: unknown }).status)}`);
    }
  }
  return { status: "failed", error: "relay_loop_bound" };
}

type IntentParams =
  | { side: "BUY"; tokenId: string; allInCapMicro: string; maxPriceBp: number }
  | { side: "SELL"; tokenId: string; sharesMicro: string; minPriceBp: number };

export async function placeRealOrder(
  api: Api,
  ctx: RealCtx,
  input: { marketId: string; side: "YES" | "NO"; stakeCents?: number; dir?: "ENTRY" | "EXIT" },
): Promise<{ status: string; filledSharesMicro?: string }> {
  const intent = (await api("/api/real/intent", { method: "POST", body: JSON.stringify(input) })) as {
    intentId: string;
    params: IntentParams;
  };

  const client = await getRealClient(ctx);
  const signer = privySigner(ctx.wallet);
  // The builder field is SIGNED into the order and the server validates it, so a missing code fails
  // loudly at /api/real/submit instead of quietly posting unattributed volume.
  const code = process.env.NEXT_PUBLIC_POLYMARKET_BUILDER_CODE;
  const builder = code ? { builderCode: code } : {};

  const workflow =
    intent.params.side === "SELL"
      ? await prepareMarketOrder(client, {
          tokenId: intent.params.tokenId,
          side: OrderSide.SELL,
          shares: Number(intent.params.sharesMicro) / 1e6,
          minPrice: (intent.params.minPriceBp / 10_000).toFixed(4),
          ...builder,
        } as never)
      : await prepareMarketOrder(client, {
          tokenId: intent.params.tokenId,
          side: OrderSide.BUY,
          // Micro-USD → dollars, never rounded up: the cap is what the server approved to be spent.
          amount: Number(intent.params.allInCapMicro) / 1e6,
          maxPrice: (intent.params.maxPriceBp / 10_000).toFixed(4),
          ...builder,
        } as never);

  let next = await workflow.next();
  while (!next.done) {
    // Built in-process by the SDK, so unlike relay payloads this one needs no rehydration.
    const request = next.value as { payload?: unknown };
    const signature = await signer.signTypedData(request.payload as never);
    next = await workflow.next(signature as never);
  }

  // Forward the signed order VERBATIM — rebuilding it field by field risks a digest mismatch.
  const result = await api("/api/real/submit", {
    method: "POST",
    body: JSON.stringify({ intentId: intent.intentId, signedOrder: next.value }),
  });
  return result as { status: string; filledSharesMicro?: string };
}
