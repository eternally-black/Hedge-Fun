"use client";

// Browser-side orchestrator for the real-money paths: it owns the Polymarket SecureClient, the
// provisioning flow, the signature relay and the order flow. Every signature comes from the device
// through privySigner (D5) — the server relays requests and validates results, it never signs.
// React-free on purpose: the screen calls these, and so can a harness.
import { createSecureClient, remoteBuilderSigning, OrderSide } from "@polymarket/client";
import {
  isWalletDeployed,
  deployDepositWallet,
  prepareMarketOrder,
  fetchClosedOnlyMode,
} from "@polymarket/client/actions";
import { privySigner, rehydrateBigints, type EvmWalletLike } from "./real-signer";
import { assertRelayPayload } from "./relay-guard";

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

export type WorkflowKind = "APPROVALS" | "WRAP" | "REDEEM" | "WITHDRAW" | "BRIDGE_OUT";
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

type RelayLoopOptions = {
  firstResponse?: WorkflowResponse; // a run another route already started (BRIDGE_OUT)
  expectedRecipient?: string; // the bridge address the device must see inside the transfer
  onStep?: (note: string) => void;
};

async function runRelayLoop(
  api: Api,
  ctx: RealCtx,
  kind: WorkflowKind,
  options: RelayLoopOptions = {},
): Promise<WorkflowOutcome> {
  // No SecureClient here: the relay needs signatures, not CLOB creds, and constructing one would
  // cost an extra device prompt for nothing.
  const signer = privySigner(ctx.wallet);
  let answer: { runId: string; requestHash: string; signature: string } | undefined;
  let restarts = 0;
  let step = 0;
  let response: WorkflowResponse | undefined = options.firstResponse;

  // Bounded: a server that keeps yielding must not be able to prompt the device forever.
  for (let i = 0; i < 12; i++) {
    if (!response) {
      response = (await api("/api/real/workflow", {
        method: "POST",
        body: JSON.stringify(answer ? { kind, answer } : { kind }),
      })) as WorkflowResponse;
    }
    answer = undefined;

    switch (response.status) {
      case "pending_signature": {
        const request = response.request as { kind?: unknown; payload?: unknown };
        // The device decides what it is willing to sign. Rehydrate FIRST so the guard reads the same
        // values the wallet will (our wire form stringifies BigInt), then refuse anything that is not
        // this user's own deposit-wallet batch on this chain (relay-guard.ts).
        const payload = rehydrateBigints(request.payload);
        assertRelayPayload(
          kind,
          { kind: request.kind, payload },
          { depositWallet: ctx.depositWalletAddress ?? "", expectedRecipient: options.expectedRecipient },
        );
        const signature = await signer.signTypedData(payload as never);
        answer = { runId: response.runId, requestHash: response.requestHash, signature };
        options.onStep?.(`signed step ${++step}`);
        response = undefined;
        continue;
      }
      case "stale":
        // A stale BRIDGE_OUT is terminal: only /api/real/withdraw may start one, and going back there
        // would mint a SECOND single-purpose bridge address while the first stays live.
        if (kind === "BRIDGE_OUT") return { status: "failed", error: "workflow_stale" };
        if (restarts++ >= 2) return { status: "failed", error: "workflow_stale" };
        options.onStep?.("run went stale — restarting");
        response = undefined;
        continue;
      case "submitting":
        options.onStep?.("submitted to the relayer");
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

export async function runRealWorkflow(
  api: Api,
  ctx: RealCtx,
  kind: WorkflowKind,
  onStep?: (note: string) => void,
): Promise<WorkflowOutcome> {
  return runRelayLoop(api, ctx, kind, { onStep });
}

// The money-out leg. /api/real/withdraw mints the single-purpose bridge address AND starts the run,
// so the loop is entered with that first response — and with that address as the recipient the guard
// pins, which is what stops a compromised server from retargeting the transfer.
export async function withdrawViaBridge(
  api: Api,
  ctx: RealCtx,
  params: { chainId: string; tokenAddress: string; recipient: string; amountMicro?: string },
  onStep?: (note: string) => void,
): Promise<WorkflowOutcome & { bridgeAddress?: string }> {
  const started = (await api("/api/real/withdraw", {
    method: "POST",
    body: JSON.stringify(params),
  })) as WorkflowResponse & { bridgeAddress?: string };
  if (!started.bridgeAddress) throw new Error("bridge_address_missing");
  const outcome = await runRelayLoop(api, ctx, "BRIDGE_OUT", {
    firstResponse: started,
    expectedRecipient: started.bridgeAddress,
    onStep,
  });
  return { ...outcome, bridgeAddress: started.bridgeAddress };
}

type IntentParams =
  | { side: "BUY"; tokenId: string; allInCapMicro: string; maxPriceBp: number }
  | { side: "SELL"; tokenId: string; sharesMicro: string; minPriceBp: number };

// /api/real/intent REQUIRES a browser-side geo verdict (plan §2.7 — policy, not proof; Polymarket's
// own IP rejection is the real barrier). `fetchClosedOnlyMode` is the only geo signal the SDK
// exposes: a restricted caller is refused outright, a close-only tier answers with the flag set.
async function geoVerdict(client: SecureClient): Promise<{ blocked: boolean; closedOnly: boolean }> {
  try {
    return { blocked: false, closedOnly: await fetchClosedOnlyMode(client) };
  } catch (e) {
    // ONLY a refusal is a geo verdict. A transport hiccup rethrows rather than reading as "you are
    // in a banned country" — the wrong diagnosis on the money path is worse than no order.
    const status = (e as { status?: number }).status;
    if (status === 403 || status === 451) return { blocked: true, closedOnly: true };
    throw e;
  }
}

export async function placeRealOrder(
  api: Api,
  ctx: RealCtx,
  input: { marketId: string; side: "YES" | "NO"; stakeCents?: number; dir?: "ENTRY" | "EXIT" },
): Promise<{ status: string; filledSharesMicro?: string }> {
  const client = await getRealClient(ctx);
  const intent = (await api("/api/real/intent", {
    method: "POST",
    body: JSON.stringify({ ...input, geo: await geoVerdict(client) }),
  })) as {
    intentId: string;
    params: IntentParams;
  };

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
          // Micro-USD → dollars. `amount` alone is FEE-EXCLUSIVE — the SDK's own words: "Leave
          // [maxSpend] unset to pay fees on top of amount". Our stake IS the all-in cap, so both
          // fields carry it and the SDK resizes the buy to fit fees inside it. Omitting maxSpend
          // debits more than the user approved and still passes the server's makerAmount check.
          amount: Number(intent.params.allInCapMicro) / 1e6,
          maxSpend: Number(intent.params.allInCapMicro) / 1e6,
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
