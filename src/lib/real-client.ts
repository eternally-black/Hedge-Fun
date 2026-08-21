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
  postOrder,
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

export async function getRealClient(api: Api, ctx: RealCtx): Promise<SecureClient> {
  const key = `${ctx.wallet.address.toLowerCase()}:${ctx.depositWalletAddress ?? ""}`;
  const cached = clientCache.get(key);
  if (cached) return cached;

  // Build from the creds this account already derived, exactly as the server does
  // (polymarket-server.ts). Without them the SDK asks the exchange for a fresh key on every page
  // load, and the CLOB answers POST /auth/api-key with 400 once one exists for the address — which
  // is what killed the first real swipe, before any of our own routes were reached.
  //
  // 404 is the normal first-run answer: nothing has been derived yet, so we fall through and let the
  // SDK derive, and provisionReal stores the result. Any other failure falls through too — deriving
  // is the behaviour we already had, so a creds read that breaks can only cost a round trip.
  let credentials: { key: string; secret: string; passphrase: string } | undefined;
  try {
    credentials = (await api("/api/real/creds")) as typeof credentials;
  } catch {
    credentials = undefined;
  }

  const client = await createSecureClient({
    signer: privySigner(ctx.wallet),
    wallet: ctx.depositWalletAddress ?? undefined,
    ...(credentials ? { credentials } : {}),
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
  const client = await getRealClient(api, ctx);

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
  expectedAmountMicro?: string; // and how much: word 1 of the transfer, not just word 0
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
          {
            depositWallet: ctx.depositWalletAddress ?? "",
            expectedRecipient: options.expectedRecipient,
            expectedAmountMicro: options.expectedAmountMicro,
          },
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
  })) as WorkflowResponse & { bridgeAddress?: string; amountMicro?: string };
  if (!started.bridgeAddress) throw new Error("bridge_address_missing");
  const outcome = await runRelayLoop(api, ctx, "BRIDGE_OUT", {
    firstResponse: started,
    expectedRecipient: started.bridgeAddress,
    // Prefer the amount the USER typed over the one the server echoed: pinning the payload against
    // a number from the same server that built it only catches a buggy server, not a hostile one.
    // An empty amount means "send everything", which only the server can resolve to a figure, so
    // there the echoed value is all the device has — still better than leaving word 1 unchecked.
    // `?? ` alone would let an empty string through, and the guard treats "" as unreadable and
    // refuses to sign — killing exactly the "send everything" case this line exists to support. The
    // shipped card already sends undefined for it, but this function is exported and the failure
    // would be a refusal to withdraw, so it is normalised here rather than trusted upstream.
    expectedAmountMicro: params.amountMicro?.trim() ? params.amountMicro.trim() : started.amountMicro,
    onStep,
  });
  return { ...outcome, bridgeAddress: started.bridgeAddress };
}

type IntentParams =
  | {
      side: "BUY";
      tokenId: string;
      allInCapMicro: string;
      amountMicro: string;
      maxPriceBp: number;
      quote: { feeMicro: string };
    }
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
  // quotedPriceBp = the price the user actually saw on the card. The server refuses the intent if
  // the book has since moved against them past tolerance — same contract as the paper /api/swipe.
  input: {
    marketId: string;
    side: "YES" | "NO";
    stakeCents?: number;
    dir?: "ENTRY" | "EXIT";
    quotedPriceBp?: number;
  },
): Promise<{ status: string; filledSharesMicro?: string }> {
  const client = await getRealClient(api, ctx);
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
  // The SDK's `builderCode` is NOT a human-readable name: toBuilderCode throws unless it is exactly
  // a 32-byte hex string (0x + 64 hex chars). A plain word here would fail as a TypeError from
  // inside prepareMarketOrder, at order-placement time, on every attributed order. Checked at the
  // point the env is read so a misconfigured deployment says what is wrong instead of surfacing as
  // a Zod failure deep in the SDK. Absent is fine and stays fine — that arm just posts unattributed.
  const code = process.env.NEXT_PUBLIC_POLYMARKET_BUILDER_CODE;
  if (code && !/^0x[0-9a-fA-F]{64}$/.test(code)) {
    throw new Error("NEXT_PUBLIC_POLYMARKET_BUILDER_CODE must be a 32-byte hex string (0x + 64 hex chars)");
  }
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
          // Micro-USD → dollars. `amount` is FEE-EXCLUSIVE — the SDK's own words: "Leave [maxSpend]
          // unset to pay fees on top of amount" — and it is now the user's STAKE itself: the fee
          // rides on top, out of the free balance (owner, 2026-08-17), because taking it out of the
          // stake posted $0.96 on a $1 swipe and the exchange refuses anything under its own $1
          // minimum. Both numbers come from the server: `amountMicro` is the order, `allInCapMicro`
          // is the debit ceiling (stake + the worse of the two fee readings). Deriving `amount` here
          // as cap-minus-fee, as this line used to, stops meaning "the stake" the moment those two
          // readings differ.
          // maxSpend still matters: the SDK's resize reserves the fee at the order's BOUND price
          // and the curve rate·(p(1−p))^exp peaks at p=0.5, so without a ceiling a fill nearer the
          // middle debits more than the user approved. CEILING, unchanged: the exchange never sees
          // maxSpend, so the true charge can still differ from the quote by the gap between the two
          // fee points — the cap is a client-side bound on what we will sign, not an exchange rule.
          amount: Number(BigInt(intent.params.amountMicro)) / 1e6,
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
  const result = (await api("/api/real/submit", {
    method: "POST",
    body: JSON.stringify({ intentId: intent.intentId, signedOrder: next.value }),
  })) as { status: string; filledSharesMicro?: string };
  // Anything but "approved" is the server-posting locus: the server already holds the authoritative
  // receipt and has booked whatever it saw.
  if (result.status !== "approved") return result;

  // Browser-posting locus. The exchange refuses orders from our host's IP and that geo check is
  // about the TRADER, so the post belongs here, in front of the user's own connection. What goes
  // back to the server is the order ID and nothing else — a receipt from this side would let a
  // tampered client book fills, points and counters the exchange never saw, so /api/real/posted
  // reads the order back from the exchange itself before booking.
  // Cost of throwing below: the attempt stays SUBMITTING and holds this market's in-flight slot
  // until the server's discovery sweep resolves it against the exchange (~15 min), because only a
  // reading of the exchange — never a claim from here — may declare that no order exists.
  const posted = (await postOrder(client)(next.value as never)) as {
    ok?: boolean;
    orderId?: string;
    message?: string;
  };
  // A refusal comes back as ok:false with a message rather than as a throw.
  if (posted.ok === false) throw new Error(`post_rejected: ${posted.message ?? ""}`);
  if (!posted.orderId) throw new Error("post_no_order_id");
  // The order is LIVE from this line on, and the browser is holding the only copy of its id. A
  // failure REPORTING it is not a failed order, but it used to throw and the card rendered it as
  // one — telling the user their money did not move while it was filling, and inviting a retry.
  // Retry the report once, then hand back the status the card already has honest copy for
  // ("sent, outcome not yet confirmed"). The orphan sweep still resolves the attempt against the
  // exchange within ~15 minutes; this only stops a lost response from reading as a loss.
  const report = async () =>
    (await api("/api/real/posted", {
      method: "POST",
      body: JSON.stringify({ intentId: intent.intentId, orderId: posted.orderId }),
    })) as { status: string; filledSharesMicro?: string };
  try {
    return await report();
  } catch {
    try {
      return await report();
    } catch {
      return { status: "submitting" };
    }
  }
}
