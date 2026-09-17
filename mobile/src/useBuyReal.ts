// useBuyReal (native) — the ONLY place the phone touches Solana. Native twin of src/app/useBuyReal.ts: the
// server builds, the device signs, the server co-signs and books. The client never decides what a buy costs,
// never holds a key, and never marks a position as bought — the card advances only when /confirm returns a
// positionId.
//
// Two differences from the web, both forced by the platform:
//   • There is no Privy embedded wallet here. The verified set is /api/me's stockWallets and the wallet used
//     is the one the user picked in Profile (tradingWallet.ts) — the same pick the Profile reads its balance from.
//   • SPONSORED ONLY. A self-paid swap needs the wallet to send as well as sign, and the MWA port signs only;
//     a feePayer:null build is refused with a pointer at the web app rather than half-ported.
//     ponytail: add signAndSendTransactions to the wallet port + /real/sent when a self-paid path is wanted.
//
// Nothing is written to the device: a confirm lost between send and book is recovered by the server sweep
// (the attempt carries the signature) and by the portfolio's wallet-lot adoption.
import { useCallback, useMemo, useRef, useState } from "react";
import { STOCK_TERMS_VERSION } from "../lib/config";
import { usd } from "./format";
import * as wallet from "./platform/wallet.flavor";
import { pickTradingWallet, useTradingWalletChoice } from "./tradingWallet";
import type { Api } from "./api";
import type {
  MeResponse,
  StockPortfolioResponse,
  StockRealTxResponse,
  StockRealSellTxResponse,
  StockRealSubmitResponse,
  StockRealConfirmResponse,
} from "@contract/api-types";

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

// Error status + code, read the way the rest of the app reads them off a thrown api() failure.
function errStatus(e: unknown): number | undefined {
  return (e as { status?: number }).status;
}
function errCode(e: unknown): string | undefined {
  return (e as { body?: { error?: string } }).body?.error;
}

// "+$1.05" / "−$0.40" (U+2212) — usd() formats the magnitude, the sign is ours.
function signed(cents: number): string {
  return `${cents >= 0 ? "+" : "−"}${usd(Math.abs(cents))}`;
}

export function useBuyReal(p: {
  api: Api;
  me: MeResponse | null;
  onToast: (m: string) => void;
  onDone?: (r: { symbol: string; qtyBase: string; costCents: number }) => void;
  // The screen's way to send the user to Profile → Connect wallet. There is no in-place link flow on the phone.
  onNeedWallet?: () => void;
  // What the screen already knows (wallets / consent / sponsored). Read during render only — never a
  // callback dependency — so the exposed callbacks stay stable.
  ctx?: BuyRealCtx;
}): {
  buyReal: (target: BuyRealTarget, stakeCents: number, ctx?: BuyRealCtx, opts?: { hedgeSuggestionId?: string }) => Promise<void>;
  sellReal: (positionId: string, opts?: { symbol?: string; ctx?: BuyRealCtx }) => Promise<void>;
  busy: boolean;
  consentOpen: boolean;
  /** True only when the server recorded the acceptance — the caller's local consent flag follows this. */
  acceptConsent: () => Promise<boolean>;
  closeConsent: () => void;
  /** The wallet the next real trade will use — the user's pick among the verified ones. */
  walletAddress: string | null;
  /** The server holds a fee-payer: the user needs USDC only, no SOL. */
  sponsored: boolean;
} {
  const { api, me, onToast, onDone, onNeedWallet, ctx: screenCtx } = p;
  const [busy, setBusy] = useState(false);
  // ONE real trade at a time, whichever screen asked for it. `busy` cannot be the guard: it is state,
  // so two taps in the same tick both read it as false and both spend the user's USDC.
  const inFlight = useRef(false);
  const [consentOpen, setConsentOpen] = useState(false);
  // The trade that was interrupted by the consent sheet. Held in a ref, not state: resuming it must
  // not re-render, and it must survive the sheet's own open/close churn.
  const heldRef = useRef<Held | null>(null);

  // ONE source for "verified": /api/me's stockWallets — the same list the Profile picks from.
  // The deck/portfolio responses carry their own copy, but two snapshots can disagree for a beat
  // (a wallet verified on another device), and then the Profile would show one wallet while the CTA
  // spends another. Keyed by content so a /api/me refresh with the same wallets keeps callback identities.
  const verifiedKey = (me?.stockWallets ?? []).join(",");
  const verified = useMemo(() => (verifiedKey ? verifiedKey.split(",") : []), [verifiedKey]);
  const hasMe = me !== null;
  // The pick is the user's (Profile → trading wallet), constrained to what the server has verified.
  const choice = useTradingWalletChoice();
  const walletAddress = pickTradingWallet(verified, choice);

  // sign → land → book: the one place a signature becomes a booked lot. A buy and a sell reach it
  // with different quotes and leave it with different toasts; everything between is identical.
  const signSubmitConfirm = useCallback(
    async (built: BuiltSwap): Promise<StockRealConfirmResponse | null> => {
      // SPONSORED ONLY. A self-paid swap is signed AND sent by the wallet, and the MWA port signs only —
      // so the honest answer is to point at the web app rather than build a half-working path.
      if (built.feePayer === null) {
        onToast("Self-paid trades aren't available in the app yet — use the web app");
        return null;
      }

      // SPONSORED: sign only. The server co-signs and sends, so the user needs USDC and no SOL at all.
      onToast("Confirm in your wallet…");
      let signedTransaction: string;
      try {
        // Base64 in, base64 out — the wallet port speaks the wire format, no byte conversion here.
        signedTransaction = await wallet.signTransaction(built.swapTransaction);
      } catch (e) {
        // A deliberate cancel is the user's own decision — silent, no toast.
        if (wallet.isUserCancel(e)) return null;
        if (wallet.isNoWallet(e)) onToast("No Solana wallet app found on this phone");
        else onToast("Couldn't sign the transaction");
        return null;
      }

      let sig: string;
      try {
        const r = (await api("/api/stocks/real/submit", {
          method: "POST",
          body: JSON.stringify({ attemptId: built.attemptId, signedTransaction }),
        })) as StockRealSubmitResponse;
        sig = r.sig;
      } catch (e) {
        const status = errStatus(e);
        const code = errCode(e);
        if (status === 409 && code === "tx_mismatch") onToast("Something changed — try again");
        else if (status === 409 && code === "attempt_expired") onToast("That quote expired — try again");
        else if (status === 409 && code === "lot_closed") onToast("This lot was already sold");
        else if (status === 429) onToast("Daily limit of sponsored trades reached — try again tomorrow");
        // No status (the network dropped, the request timed out) or any 5xx: the send was ATTEMPTED
        // with the signature already stamped on the attempt, so a lost acknowledgement is recovered
        // by the server sweep. Inviting a retry here would double-spend — and a rebuild is refused
        // with buy_in_flight anyway, so promising "try again" would be a lie as well.
        else if (status === undefined || status >= 500) onToast("Solana is busy — if it went through, your lot appears within a few minutes");
        else onToast("Couldn't send the transaction");
        return null;
      }

      // No pending entry is written on the phone. The attempt already carries the signature (the server
      // stamped it in /real/submit before sending), so a confirm lost between here and the book is
      // recovered by the server sweep — and by the portfolio's wallet-lot adoption, which finds the
      // tokens in the wallet even if the attempt row is gone. Nothing to replay from the device.

      onToast("Confirming on Solana…");

      // Confirm, with retries. A 404 means the tx has not landed yet — the chain is a beat behind
      // the server's own "sent" answer. Six attempts, 2s apart, is ~12s of patience.
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

      return confirmed;
    },
    [api, onToast],
  );

  // The whole buy, from a resolved ctx to a booked position. Defined as a stable inner function so
  // acceptConsent can resume it without re-entering buyReal's own ctx fetch.
  const runBuy = useCallback(
    async (target: BuyRealTarget, stakeCents: number, ctx: BuyRealCtx, opts?: { hedgeSuggestionId?: string }) => {
      // 1. Wallet. There is no embedded wallet on the phone: the verified set is the server's, and the
      //    pick is the user's. `ctx.wallets` is only the fallback for a caller that has no /api/me yet;
      //    the pick itself uses the same list the Profile reads, so what is shown is what gets spent.
      if (!wallet.available) {
        onToast("Real-money trades aren't available in this build");
        return;
      }
      const verifiedNow = verified.length > 0 || hasMe ? verified : ctx.wallets;
      const payer = pickTradingWallet(verifiedNow, walletAddress);
      if (payer === null) {
        onNeedWallet?.();
        onToast("Connect your wallet in Profile to buy with real money");
        return;
      }

      // 2. Build. The server derives the swap from the asset + stake; nothing is spent here.
      let tx: StockRealTxResponse;
      try {
        tx = (await api("/api/stocks/real/tx", {
          method: "POST",
          body: JSON.stringify({ assetId: target.assetId || undefined, symbol: target.symbol, stakeCents, payer, hedgeSuggestionId: opts?.hedgeSuggestionId }),
        })) as StockRealTxResponse;
      } catch (e) {
        const status = errStatus(e);
        const code = errCode(e);
        if (status === 403 && code === "stock_consent_required") {
          heldRef.current = { kind: "buy", target, stakeCents, ctx, opts };
          setConsentOpen(true);
        } else if (status === 403 && code === "wallet_not_verified") {
          onNeedWallet?.();
          onToast("Connect your wallet in Profile to buy with real money");
        } else if (status === 409 && code === "price_impact") {
          onToast("Too thin to buy right now");
        } else if (status === 409 && code === "insufficient_usdc") {
          onToast("Not enough in your Solana wallet — add at least $1");
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

      // The server sizes the swap to what the wallet holds when the chip is larger than the balance
      // (the quote carries the amount really used) — say so before the signature, not after.
      const usedCents = Math.floor(Number(tx.quote.inAmountMicro) / 10_000);
      if (usedCents < stakeCents) onToast(`Buying with your full ${usd(usedCents)}`);

      // 3. Sign, land, book — and only then advance the card.
      const confirmed = await signSubmitConfirm(tx);
      if (!confirmed) return;
      onToast(`Bought ${target.symbol} on Solana ✓`);
      onDone?.({ symbol: target.symbol, qtyBase: confirmed.qtyBase, costCents: confirmed.costCents });
    },
    [api, hasMe, onDone, onNeedWallet, onToast, signSubmitConfirm, verified, walletAddress],
  );

  // The mirror image: sell ONE open REAL lot in full. Same three beats as a buy — build, sign, book —
  // through the same tail.
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
          // Non-consent 403: the wallet that holds the lot is not one this account has verified.
          onNeedWallet?.();
          onToast("Connect the wallet that holds this lot in Profile");
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
      // answer (tx.payer), not our pick. There is no wallet list to search — the wallet app signs with
      // the account that holds the key (and refuses if it does not), and the server has already
      // checked that this lot belongs to the caller.
      const confirmed = await signSubmitConfirm(tx);
      if (!confirmed) return;
      const symbol = opts?.symbol ?? "";
      onToast(`Sold ${symbol}${symbol ? " " : ""}· ${signed(confirmed.pnlCents ?? 0)}`);
      onDone?.({ symbol, qtyBase: confirmed.qtyBase, costCents: confirmed.costCents });
    },
    [api, onDone, onNeedWallet, onToast, signSubmitConfirm],
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

  // The consent sheet's accept. POSTs the CURRENT terms version, so a stale screen cannot accept a
  // text it never rendered, then resumes whichever trade opened the sheet.
  //
  // Returns whether the server RECORDED it: the caller flips its own consent flag off this answer.
  // Resolving on a failed POST let the card say "Buy", the next /real/tx 403 and the sheet reopen —
  // a loop with no way out.
  const acceptConsent = useCallback(async (): Promise<boolean> => {
    // The resumed trade runs here, not through buyReal — so the same one-at-a-time guard applies.
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    try {
      try {
        await api("/api/stocks/consent", { method: "POST", body: JSON.stringify({ version: STOCK_TERMS_VERSION }) });
      } catch {
        onToast("Couldn't record your acceptance — try again"); // the sheet stays open on purpose
        return false;
      }
      setConsentOpen(false);
      const held = heldRef.current;
      heldRef.current = null;
      if (held?.kind === "buy") await runBuy(held.target, held.stakeCents, { ...held.ctx, stockConsent: true }, held.opts);
      else if (held?.kind === "sell") await runSell(held.positionId, { ...held.ctx, stockConsent: true }, held.opts);
      return true;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [api, onToast, runBuy, runSell]);

  const closeConsent = useCallback(() => {
    setConsentOpen(false);
    heldRef.current = null;
  }, []);

  return {
    buyReal,
    sellReal,
    busy,
    consentOpen,
    acceptConsent,
    closeConsent,
    walletAddress,
    sponsored: screenCtx?.sponsored ?? false,
  };
}
