"use client";

import { useCallback, useRef, useState } from "react";
import { useLinkAccount, useConnectWallet, usePrivy, type WalletWithMetadata } from "@privy-io/react-auth";
import {
  useWallets as useSolanaWallets,
  useSignAndSendTransaction,
  useSignTransaction,
  type ConnectedStandardSolanaWallet,
} from "@privy-io/react-auth/solana";
import { STOCK_TERMS_VERSION } from "@/lib/config";
import { usd, type Me } from "./ui";
import type {
  HedgeWalletResponse,
  StockPortfolioResponse,
  StockRealTxResponse,
  StockRealSellTxResponse,
  StockRealSubmitResponse,
  StockRealConfirmResponse,
} from "@/lib/api-types";

// The ONLY place the browser touches Solana. Everything else in the stock deck is HTTP; this hook
// owns the one flow that cannot be — building a swap server-side, signing it in the user's own
// wallet, and confirming the landed transaction back to the server.
//
// The shape of the flow is deliberate: the server builds, the device signs, the server books. The
// client never decides what a buy costs, never holds a key, and never marks a position as bought —
// the card advances only when /confirm returns a positionId.
//
// Two signing shapes live here, and the server picks which one per transaction:
//   feePayer null     → SELF-PAID: the wallet signs AND sends (signAndSendTransaction), then /sent.
//   feePayer non-null → SPONSORED: the wallet SIGNS ONLY, /real/submit co-signs and sends. The user
//                       needs USDC and no SOL at all, which is what makes the embedded wallet usable.

type Api = (path: string, init?: RequestInit) => Promise<unknown>;

export interface BuyRealTarget { assetId: string; symbol: string }
export interface BuyRealCtx { wallets: string[]; stockConsent: boolean; sponsored?: boolean }

// What the consent sheet interrupted. A buy and a sell both hit the same 403, and both must resume
// on accept — so the held action carries its own kind rather than being assumed to be a buy.
type Held =
  | { kind: "buy"; target: BuyRealTarget; stakeCents: number; ctx: BuyRealCtx; opts?: { hedgeSuggestionId?: string } }
  | { kind: "sell"; positionId: string; ctx: BuyRealCtx; opts?: { symbol?: string } };

// The only three fields of a built swap the sign → land → book tail needs. /real/tx and
// /real/sell-tx differ in their quote, never in how the signature is collected and confirmed.
type BuiltSwap = { attemptId: string; swapTransaction: string; feePayer: string | null };

// The mainnet chain literal, exactly as @privy-io/react-auth/solana declares it (SolanaChain).
const SOLANA_MAINNET = "solana:mainnet" as const;

// Base58 ENCODER — ~20 lines, no dependency. A Solana signature comes back from the wallet as raw
// bytes; every server route and every explorer speaks base58. The alphabet excludes 0/O/I/l.
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function encodeBase58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [0];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]!];
  return out;
}

// Signed wire tx → base64, the shape /real/submit takes. A byte-at-a-time loop rather than
// String.fromCharCode(...bytes): a swap is ~1.2 KB today, and a spread that big is a stack overflow
// waiting for the day a route adds one more instruction.
function encodeBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

// A pending buy, parked in localStorage between "the wallet sent it" and "the server booked it".
// The tab can die in that window (a phone call, a swipe-away), and the money is already gone — so
// the signature is written down BEFORE the confirm call, and replayed on the next visit.
type PendingEntry = { attemptId: string; sig: string };

function pendingKey(userId: string, payer: string): string {
  return `hf_stock_pending:${userId}:${payer}`;
}

function readPending(key: string): PendingEntry[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is PendingEntry => !!e && typeof e === "object" && typeof (e as PendingEntry).attemptId === "string" && typeof (e as PendingEntry).sig === "string");
  } catch {
    return [];
  }
}

function writePending(key: string, entries: PendingEntry[]): void {
  try {
    if (entries.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(entries));
  } catch { /* storage blocked — the buy still confirms, it just cannot be replayed */ }
}

// Error status + code, read the way page.tsx reads them off a thrown api() failure.
function errStatus(e: unknown): number | undefined {
  return (e as { status?: number }).status;
}
function errCode(e: unknown): string | undefined {
  return (e as { body?: { error?: string } }).body?.error;
}

// ensureVerified's one refusal: the POST succeeded but the server could not confirm ownership, so
// the address must NOT be treated as usable. Exported because the fund panel awaits it too.
export function isWalletUnverified(e: unknown): boolean {
  return e instanceof Error && e.message === "wallet_unverified";
}

// A deliberate cancel is the user's own decision — silent, no toast.
function isUserReject(e: unknown): boolean {
  return /reject|denied|cancel/i.test(e instanceof Error ? e.message : String(e));
}

// "+$1.05" / "−$0.40" (U+2212) — usd() formats the magnitude, the sign is ours.
function signed(cents: number): string {
  return `${cents >= 0 ? "+" : "−"}${usd(Math.abs(cents))}`;
}

export function useBuyReal(p: {
  api: Api;
  me: Me | null;
  onToast: (m: string) => void;
  onDone?: (r: { symbol: string; qtyBase: string; costCents: number }) => void;
  // Called after the embedded wallet is verified server-side, so the screen re-reads its wallet list.
  onRefreshMe?: () => void | Promise<void>;
  // What the screen already knows (wallets / consent / sponsored). Read during render only — never a
  // callback dependency — so the exposed callbacks stay stable for the fund panel's poll effect.
  ctx?: BuyRealCtx;
}): {
  buyReal: (target: BuyRealTarget, stakeCents: number, ctx?: BuyRealCtx, opts?: { hedgeSuggestionId?: string }) => Promise<void>;
  sellReal: (positionId: string, opts?: { symbol?: string; ctx?: BuyRealCtx }) => Promise<void>;
  busy: boolean;
  consentOpen: boolean;
  acceptConsent: () => Promise<void>;
  closeConsent: () => void;
  replayPending: () => Promise<number>;
  /** The wallet the next real trade will use — external-verified first, else the embedded one. */
  walletAddress: string | null;
  /** True when that wallet is the Privy embedded one (no popup to sign, nothing to install). */
  embedded: boolean;
  /** The server holds a fee-payer: the user needs USDC only, no SOL. */
  sponsored: boolean;
  /** Tell the server about an embedded wallet it hasn't seen. Once per address per session. */
  ensureVerified: (address: string) => Promise<void>;
} {
  const { api, me, onToast, onDone, onRefreshMe, ctx: screenCtx } = p;
  const [busy, setBusy] = useState(false);
  // ONE real trade at a time, whichever screen asked for it. `busy` cannot be the guard: it is state,
  // so two taps in the same tick both read it as false and both spend the user's USDC.
  const inFlight = useRef(false);
  const [consentOpen, setConsentOpen] = useState(false);
  // The trade that was interrupted by the consent sheet. Held in a ref, not state: resuming it must
  // not re-render, and it must survive the sheet's own open/close churn.
  const heldRef = useRef<Held | null>(null);

  const { wallets: solWallets, ready: walletsReady } = useSolanaWallets();
  const { signAndSendTransaction } = useSignAndSendTransaction();
  const { signTransaction } = useSignTransaction();
  const { user } = usePrivy();

  // The Privy EMBEDDED Solana wallet. A ConnectedStandardSolanaWallet carries only `address` and
  // `standardWallet`, so "is this one ours" cannot be asked of the connected wallet — it is asked of
  // the LINKED ACCOUNT that created it, where walletClientType === 'privy' is the SDK's own marker.
  const embeddedAddress =
    user?.linkedAccounts.find(
      (a): a is WalletWithMetadata => a.type === "wallet" && a.chainType === "solana" && a.walletClientType === "privy",
    )?.address ?? null;

  // Which wallet a real trade uses: a CONNECTED external wallet the server already verified wins —
  // the user deliberately linked that one — else the embedded wallet, which every login now has.
  const pickWallet = useCallback(
    (verified: readonly string[]): ConnectedStandardSolanaWallet | null => {
      const set = new Set(verified);
      return (
        solWallets.find((w) => w.address !== embeddedAddress && set.has(w.address)) ??
        solWallets.find((w) => w.address === embeddedAddress) ??
        null
      );
    },
    [embeddedAddress, solWallets],
  );

  const wallet = pickWallet(screenCtx?.wallets ?? []);
  const walletAddress = wallet?.address ?? null;
  const embedded = walletAddress !== null && walletAddress === embeddedAddress;

  // Addresses this session already handed to the server. An embedded wallet is a Privy LINKED
  // account, so /api/hedge/wallet can verify it through Privy without a signature prompt — but it is
  // a write, and both the first trade and the fund panel want it done, so it runs at most once.
  const verifiedOnce = useRef<Set<string>>(new Set());
  const ensureVerified = useCallback(
    async (address: string): Promise<void> => {
      if (verifiedOnce.current.has(address)) return;
      verifiedOnce.current.add(address);
      try {
        // 200 is NOT "verified": the route never refuses on a Privy outage, it answers 200 with
        // verified:false. Caching that would leave the wallet unusable for the rest of the session —
        // every balance read 403s and a buy sends an embedded-wallet user into the link flow.
        const r = (await api("/api/hedge/wallet", { method: "POST", body: JSON.stringify({ address }) })) as HedgeWalletResponse;
        if (!r.verified) throw new Error("wallet_unverified");
        await onRefreshMe?.();
      } catch (e) {
        verifiedOnce.current.delete(address); // a failed verify must stay retryable, not stick
        throw e;
      }
    },
    [api, onRefreshMe],
  );

  // Linking a wallet is a VERIFYING action: Privy makes the wallet sign a challenge, and the server
  // records the address as verified. A pasted address is read-only and cannot pay for a swap.
  const { linkWallet } = useLinkAccount({
    onSuccess: ({ linkedAccount }) => {
      if (linkedAccount?.type === "wallet" && linkedAccount.chainType === "solana") {
        void api("/api/hedge/wallet", { method: "POST", body: JSON.stringify({ address: linkedAccount.address }) })
          .then(() => onToast("Wallet linked — tap Buy on Solana again"))
          .catch(() => onToast("Couldn't link that wallet — try again"));
      }
    },
    onError: (error) => {
      if (error !== "exited_link_flow") onToast("Couldn't connect the wallet — try again");
    },
  });
  const { connectWallet } = useConnectWallet();

  // sign → land → book: the one place a signature becomes a booked lot. A buy and a sell reach it
  // with different quotes and leave it with different toasts; everything between is identical, and
  // duplicating it is how one of the two paths ends up without the pending-replay stamp.
  const signSubmitConfirm = useCallback(
    async (built: BuiltSwap, w: ConnectedStandardSolanaWallet): Promise<StockRealConfirmResponse | null> => {
      const bytes = Uint8Array.from(atob(built.swapTransaction), (c) => c.charCodeAt(0));
      const isEmbedded = w.address === embeddedAddress;
      let sig: string;

      if (built.feePayer) {
        // SPONSORED: sign only. An embedded wallet raises no popup, so "Confirm in your wallet…"
        // would point the user at a window that never opens.
        onToast(isEmbedded ? "Signing…" : "Confirm in your wallet…");
        let signedTransaction: Uint8Array;
        try {
          ({ signedTransaction } = await signTransaction({ transaction: bytes, wallet: w, chain: SOLANA_MAINNET }));
        } catch (e) {
          if (!isUserReject(e)) onToast("Couldn't sign the transaction");
          return null;
        }
        try {
          const r = (await api("/api/stocks/real/submit", {
            method: "POST",
            body: JSON.stringify({ attemptId: built.attemptId, signedTransaction: encodeBase64(signedTransaction) }),
          })) as StockRealSubmitResponse;
          sig = r.sig;
        } catch (e) {
          const status = errStatus(e);
          const code = errCode(e);
          if (status === 409 && code === "tx_mismatch") onToast("Something changed — try again");
          else if (status === 409 && code === "attempt_expired") onToast("That quote expired — try again");
          else if (status === 409 && code === "lot_closed") onToast("This lot was already sold");
          else if (status === 429) onToast("Daily limit of sponsored trades reached — try again tomorrow");
          // 502 = the send was attempted with the signature already stamped on the attempt, so a lost
          // acknowledgement is recovered by the sweep. Inviting a retry here would double-spend.
          else if (status === 502) onToast("Solana is busy — if it went through, your lot appears within a few minutes");
          else onToast("Couldn't send the transaction");
          return null;
        }
      } else {
        // SELF-PAID: the wallet owns send as well as sign, and pays the network fee out of its SOL.
        onToast("Confirm in your wallet…");
        try {
          const { signature } = await signAndSendTransaction({ transaction: bytes, wallet: w, chain: SOLANA_MAINNET });
          sig = encodeBase58(signature);
        } catch (e) {
          if (isUserReject(e)) return null;
          const msg = e instanceof Error ? e.message : String(e);
          if (/insufficient|lamports|fee/i.test(msg)) onToast("Your wallet needs a little SOL for network fees");
          else onToast("Couldn't send the transaction");
          return null;
        }
      }

      // Write the signature down BEFORE telling the server. If the tab dies between here and the
      // confirm, the next visit replays it — the money is already gone at this point.
      const key = me ? pendingKey(me.user.id, w.address) : null;
      if (key) writePending(key, [...readPending(key), { attemptId: built.attemptId, sig }]);

      // Self-paid only: a sponsored tx was sent BY /real/submit, which already stamped the signature
      // on the attempt. A second stamp would be a write for nothing.
      if (!built.feePayer) {
        try {
          await api("/api/stocks/real/sent", { method: "POST", body: JSON.stringify({ attemptId: built.attemptId, sig }) });
        } catch { /* the poller sweep covers this */ }
      }

      onToast("Confirming on Solana…");

      // Confirm, with retries. A 404 means the tx has not landed yet — the chain is a beat behind
      // the wallet's own "sent" answer. Six attempts, 2s apart, is ~12s of patience.
      let confirmed: StockRealConfirmResponse | null = null;
      for (let i = 0; i < 6; i++) {
        try {
          confirmed = (await api("/api/stocks/real/confirm", {
            method: "POST",
            body: JSON.stringify({ attemptId: built.attemptId, sig }),
          })) as StockRealConfirmResponse;
          break;
        } catch (e) {
          if (errStatus(e) === 404) {
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
          const code = errCode(e);
          if (errStatus(e) === 409 && code === "tx_failed") onToast("The transaction failed on Solana");
          else if (errStatus(e) === 409 && code === "not_this_buy") onToast("That transaction didn't match");
          else if (errStatus(e) === 409 && code === "attempt_expired") onToast("That quote expired — try again");
          else if (errStatus(e) === 502) onToast("Solana RPC is busy — it will be picked up automatically");
          else onToast("Couldn't confirm — it will be picked up automatically");
          return null;
        }
      }
      if (!confirmed) {
        onToast("Still confirming — it will be picked up automatically");
        return null;
      }

      // Booked. Drop the pending entry; the caller says what happened.
      if (key) writePending(key, readPending(key).filter((e) => e.sig !== sig));
      return confirmed;
    },
    [api, embeddedAddress, me, onToast, signAndSendTransaction, signTransaction],
  );

  // The whole buy, from a resolved ctx to a booked position. Defined as a stable inner function so
  // acceptConsent can resume it without re-entering buyReal's own ctx fetch.
  const runBuy = useCallback(
    async (target: BuyRealTarget, stakeCents: number, ctx: BuyRealCtx, opts?: { hedgeSuggestionId?: string }) => {
      // 1. Wallet. The verified set is the server's; the connected set is Privy's. With an embedded
      //    wallet there is always one to use, so the link/connect prompts are the no-wallet case only.
      const w = pickWallet(ctx.wallets);
      if (!w) {
        // Privy provisions the embedded wallet on login, but it appears a beat later. Opening the
        // Phantom link modal in that beat would tell a user who already HAS a wallet to go get one.
        if (!walletsReady) {
          onToast("Setting up your wallet — try again in a moment");
        } else if (ctx.wallets.length > 0) {
          connectWallet({ walletChainType: "solana-only" });
          onToast("Connect the wallet you linked, then tap again");
        } else {
          linkWallet({ walletChainType: "solana-only", description: "Connect the Phantom wallet you buy stocks with" });
        }
        return;
      }
      // The embedded wallet is brand new to the server on the first trade — /real/tx refuses a payer
      // it has not verified, so tell it first rather than bouncing the user through a link flow.
      if (!ctx.wallets.includes(w.address)) {
        try {
          await ensureVerified(w.address);
        } catch (e) {
          onToast(isWalletUnverified(e) ? "Couldn't verify your wallet — try again in a moment" : "Couldn't set up your wallet — try again");
          return;
        }
      }

      // 2. Build. The server derives the swap from the asset + stake; nothing is spent here.
      let tx: StockRealTxResponse;
      try {
        tx = (await api("/api/stocks/real/tx", {
          method: "POST",
          body: JSON.stringify({ assetId: target.assetId || undefined, symbol: target.symbol, stakeCents, payer: w.address, hedgeSuggestionId: opts?.hedgeSuggestionId }),
        })) as StockRealTxResponse;
      } catch (e) {
        const status = errStatus(e);
        const code = errCode(e);
        if (status === 403 && code === "stock_consent_required") {
          heldRef.current = { kind: "buy", target, stakeCents, ctx, opts };
          setConsentOpen(true);
        } else if (status === 403 && code === "wallet_not_verified") {
          linkWallet({ walletChainType: "solana-only", description: "Connect the Phantom wallet you buy stocks with" });
        } else if (status === 409 && code === "price_impact") {
          onToast("Too thin to buy right now");
        } else if (status === 409 && code === "insufficient_usdc") {
          onToast("Not enough USDC — send at least $1 to your wallet");
        } else if (status === 409 && code === "asset_halted") {
          onToast("Trading is halted for this stock");
        } else if (status === 409 && code === "buy_in_flight") {
          onToast("Your previous buy of this stock is still confirming — give it a minute");
        } else if (status === 409 && code === "hedge_already_accepted") {
          onToast("You already hold this hedge");
        } else if (status === 502 && code === "swap_unavailable") {
          onToast("Jupiter is busy — try again");
        } else if (status === 502 && code === "rpc_unavailable") {
          onToast("Solana RPC is busy — your buy will be picked up automatically");
        } else {
          onToast("Couldn't start that buy — try again");
        }
        return;
      }

      // The server sizes the swap to the wallet's USDC when the chip is larger than the balance
      // (the quote carries the amount really used) — say so before the signature, not after.
      const usedCents = Math.floor(Number(tx.quote.inAmountMicro) / 10_000);
      if (usedCents < stakeCents) onToast(`Buying with your full ${(usedCents / 100).toFixed(2)} USDC`);

      // 3. Sign, land, book — and only then advance the card.
      const confirmed = await signSubmitConfirm(tx, w);
      if (!confirmed) return;
      onToast(`Bought ${target.symbol} on Solana ✓`);
      onDone?.({ symbol: target.symbol, qtyBase: confirmed.qtyBase, costCents: confirmed.costCents });
    },
    [api, connectWallet, ensureVerified, linkWallet, onDone, onToast, pickWallet, signSubmitConfirm, walletsReady],
  );

  // The mirror image: sell ONE open REAL lot in full. Same three beats as a buy — build, sign, book —
  // through the same tail, so a sell can never drift out of sync with the pending-replay guarantee.
  const runSell = useCallback(
    async (positionId: string, ctx: BuyRealCtx, opts?: { symbol?: string }) => {
      let tx: StockRealSellTxResponse;
      try {
        tx = (await api("/api/stocks/real/sell-tx", { method: "POST", body: JSON.stringify({ positionId }) })) as StockRealSellTxResponse;
      } catch (e) {
        const status = errStatus(e);
        const code = errCode(e);
        if (status === 403 && code === "stock_consent_required") {
          heldRef.current = { kind: "sell", positionId, ctx, opts };
          setConsentOpen(true);
        } else if (status === 403) {
          linkWallet({ walletChainType: "solana-only", description: "Connect the wallet that holds this stock" });
        } else if (status === 409 && code === "lot_moved") {
          onToast("This lot isn't in your wallet anymore");
        } else if (status === 409 && code === "lot_closed") {
          onToast("Already sold");
        } else if (status === 409 && code === "sponsor_unavailable") {
          onToast("Selling on Solana isn't available right now");
        } else if (status === 409 && code === "price_impact") {
          onToast("Too thin to sell right now");
        } else if (status === 502 && code === "swap_unavailable") {
          onToast("Jupiter is busy — try again");
        } else if (status === 502) {
          onToast("Solana is busy — try again");
        } else {
          onToast("Couldn't start that sale — try again");
        }
        return;
      }

      // The LOT's own wallet signs: a sell moves tokens that live in it, so the payer is the server's
      // answer, not our pick. A lot bought from Phantom cannot be sold from the embedded wallet.
      const w = solWallets.find((x) => x.address === tx.payer);
      if (!w) {
        connectWallet({ walletChainType: "solana-only" });
        onToast("Connect the wallet that holds this lot, then tap again");
        return;
      }

      const confirmed = await signSubmitConfirm(tx, w);
      if (!confirmed) return;
      const symbol = opts?.symbol ?? "";
      onToast(`Sold ${symbol}${symbol ? " " : ""}· ${signed(confirmed.pnlCents ?? 0)}`);
      onDone?.({ symbol, qtyBase: confirmed.qtyBase, costCents: confirmed.costCents });
    },
    [api, connectWallet, linkWallet, onDone, onToast, signSubmitConfirm, solWallets],
  );

  // ctx is optional so a caller that has not loaded the portfolio yet can still trade — the portfolio
  // route is the authoritative source of both the verified wallets and consent.
  const resolveCtx = useCallback(
    async (ctx?: BuyRealCtx): Promise<BuyRealCtx | null> => {
      if (ctx) return ctx;
      try {
        const pf = (await api("/api/stocks/portfolio")) as StockPortfolioResponse;
        return { wallets: pf.wallets, stockConsent: pf.stockConsent, sponsored: pf.sponsored };
      } catch {
        onToast("Couldn't read your wallet — try again");
        return null;
      }
    },
    [api, onToast],
  );

  const buyReal = useCallback(
    async (target: BuyRealTarget, stakeCents: number, ctx?: BuyRealCtx, opts?: { hedgeSuggestionId?: string }) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      try {
        const resolved = await resolveCtx(ctx);
        if (!resolved) return;
        if (!resolved.stockConsent) {
          heldRef.current = { kind: "buy", target, stakeCents, ctx: resolved, opts };
          setConsentOpen(true);
          return;
        }
        await runBuy(target, stakeCents, resolved, opts);
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [resolveCtx, runBuy],
  );

  const sellReal = useCallback(
    async (positionId: string, opts?: { symbol?: string; ctx?: BuyRealCtx }) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      try {
        const resolved = await resolveCtx(opts?.ctx);
        if (!resolved) return;
        if (!resolved.stockConsent) {
          heldRef.current = { kind: "sell", positionId, ctx: resolved, opts };
          setConsentOpen(true);
          return;
        }
        await runSell(positionId, resolved, opts);
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [resolveCtx, runSell],
  );

  // The consent sheet's accept. POSTs the CURRENT terms version, so a stale tab cannot accept a
  // text it never rendered, then resumes whichever trade opened the sheet.
  const acceptConsent = useCallback(async () => {
    // The resumed trade runs here, not through buyReal — so the same one-at-a-time guard applies.
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await api("/api/stocks/consent", { method: "POST", body: JSON.stringify({ version: STOCK_TERMS_VERSION }) });
      setConsentOpen(false);
      const held = heldRef.current;
      heldRef.current = null;
      if (held?.kind === "buy") await runBuy(held.target, held.stakeCents, { ...held.ctx, stockConsent: true }, held.opts);
      else if (held?.kind === "sell") await runSell(held.positionId, { ...held.ctx, stockConsent: true }, held.opts);
    } catch {
      onToast("Couldn't record your acceptance — try again");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [api, onToast, runBuy, runSell]);

  const closeConsent = useCallback(() => {
    setConsentOpen(false);
    heldRef.current = null;
  }, []);

  // Replay: a trade whose tab died between send and confirm. One attempt each, no retry loop — the
  // server's own poller is the backstop, and a client that hammers confirm on every load is worse
  // than one that tries once and leaves the rest to the sweep.
  const replayPending = useCallback(async (): Promise<number> => {
    if (!me) return 0;
    let landed = 0;
    const keys: string[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(`hf_stock_pending:${me.user.id}:`)) keys.push(k);
      }
    } catch {
      return 0;
    }
    for (const key of keys) {
      const entries = readPending(key);
      const keep: PendingEntry[] = [];
      for (const entry of entries) {
        try {
          await api("/api/stocks/real/confirm", { method: "POST", body: JSON.stringify({ attemptId: entry.attemptId, sig: entry.sig }) });
          landed++;
        } catch (e) {
          const status = errStatus(e);
          // 200 or 409 = the attempt is resolved (booked, or terminally failed) — drop it either way.
          // 404/5xx = still in flight or the chain is unreachable — keep it for the next visit.
          if (status !== 404 && status !== undefined && status < 500) continue;
          keep.push(entry);
        }
      }
      writePending(key, keep);
    }
    return landed;
  }, [api, me]);

  return {
    buyReal,
    sellReal,
    busy,
    consentOpen,
    acceptConsent,
    closeConsent,
    replayPending,
    walletAddress,
    embedded,
    sponsored: screenCtx?.sponsored ?? false,
    ensureVerified,
  };
}
