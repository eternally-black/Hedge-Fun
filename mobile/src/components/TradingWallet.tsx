// TradingWallet (native) — the Profile's wallet section: connect a wallet through Mobile Wallet Adapter,
// pick which verified address is the trading wallet, and read its USDC balance. Renders nothing on a
// build with no wallet port (the Play flavor).
import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { MeResponse, MwaLinkNonceResponse, MwaLinkResponse, StockWalletResponse } from "@contract/api-types";
import { type Api, statusOf } from "../api";
import { colors } from "../theme";
import { usd } from "../format";
import * as wallet from "../platform/wallet.flavor";
import { pickTradingWallet, setTradingWalletChoice, useTradingWalletChoice } from "../tradingWallet";

const short = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;

export function TradingWallet({ me, api, onRefreshMe, onToast }: {
  me: MeResponse | null;
  api: Api;
  onRefreshMe: () => Promise<void>;
  onToast: (msg: string) => void;
}) {
  const choice = useTradingWalletChoice();
  const verified = me?.stockWallets ?? [];
  const active = pickTradingWallet(verified, choice);

  // The balance is stored WITH the address it was read for: a wallet switch does not make the old
  // number stale, it makes it someone else's money, so a mismatch renders as "Reading balance…".
  const [balance, setBalance] = useState<{ address: string; usdcCents: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);

  const readBalance = useCallback(async (address: string) => {
    setReading(true);
    try {
      const res = (await api(`/api/stocks/wallet?address=${encodeURIComponent(address)}`)) as StockWalletResponse;
      setBalance({ address: res.address, usdcCents: res.usdcCents });
    } catch (e) {
      // A read never toasts: a 403 wallet_not_verified or any other failure just leaves the last number.
      console.log("wallet balance read failed", statusOf(e) ?? e);
    } finally {
      setReading(false);
    }
  }, [api]);

  // One read whenever the active wallet changes (mount included). No poll: the Profile is not where
  // money moves, and the read is a Solana RPC call.
  useEffect(() => {
    if (!active) return;
    let alive = true;
    void (async () => {
      try {
        const res = (await api(`/api/stocks/wallet?address=${encodeURIComponent(active)}`)) as StockWalletResponse;
        if (alive) setBalance({ address: res.address, usdcCents: res.usdcCents });
      } catch (e) {
        console.log("wallet balance read failed", statusOf(e) ?? e);
      }
    })();
    return () => { alive = false; };
  }, [active, api]);

  // Connect: the server issues the Sign-In-With-Solana input, the wallet signs it, the server verifies
  // it and marks the address verified (POST /api/link/mwa). The new wallet becomes the trading wallet.
  const connect = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const siws = (await api("/api/link/mwa")) as MwaLinkNonceResponse;
      const proof = await wallet.connect(siws);
      const res = (await api("/api/link/mwa", { method: "POST", body: JSON.stringify(proof) })) as MwaLinkResponse;
      // File this wallet's grant under the verified base58 address, so signing for it later re-uses
      // the same wallet account instead of whichever one the wallet app opens first.
      await wallet.bindPayer(res.address, proof.address);
      setTradingWalletChoice(res.address);
      await onRefreshMe();
      onToast("Wallet connected ✓");
    } catch (e) {
      if (wallet.isUserCancel(e)) {
        // dismissed — silent
      } else if (wallet.isNoWallet(e)) {
        onToast("No Solana wallet app found on this phone");
      } else if (e instanceof Error && e.message === "wallet_no_siws") {
        onToast("This wallet doesn't support Sign In With Solana");
      } else {
        const status = statusOf(e);
        if (status === 400) onToast("Couldn't verify the wallet — try again");
        else if (status === 429) onToast("Too many attempts — wait a minute");
        else if (status === 503) onToast("Sign-in service is busy — try again");
        else onToast("Couldn't connect the wallet — try again");
      }
    } finally {
      setBusy(false);
    }
  };

  if (!wallet.available) return null;

  const shown = balance && balance.address === active ? usd(balance.usdcCents) : null;

  return (
    <View>
      <Text style={styles.sectionLabel}>Wallet</Text>
      <View style={styles.panel}>
        {verified.length === 0 ? (
          <Text style={styles.empty}>No wallet connected yet.</Text>
        ) : (
          verified.map((address) => {
            const isActive = address === active;
            return (
              <View key={address} style={styles.row}>
                <Text style={styles.address} numberOfLines={1}>{short(address)}</Text>
                {isActive ? (
                  <Text style={styles.activeTag}>ACTIVE</Text>
                ) : (
                  <TouchableOpacity style={styles.useBtn} onPress={() => setTradingWalletChoice(address)}>
                    <Text style={styles.useBtnText}>Use</Text>
                  </TouchableOpacity>
                )}
              </View>
            );
          })
        )}

        {active ? (
          <View style={styles.balanceRow}>
            <Text style={styles.balance}>{shown ? `${shown} USDC available` : "Reading balance…"}</Text>
            <TouchableOpacity onPress={() => void readBalance(active)} disabled={reading}>
              <Text style={styles.refreshText}>{reading ? "…" : "Refresh"}</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        <TouchableOpacity style={styles.connectBtn} onPress={() => void connect()} disabled={busy}>
          <Text style={styles.connectBtnText}>
            {busy ? "Connecting…" : verified.length === 0 ? "Connect Seeker wallet" : "Connect another wallet"}
          </Text>
        </TouchableOpacity>

        <Text style={styles.footer}>
          Buys are signed by your wallet; the app never holds a key. Network fees are on us.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  sectionLabel: {
    color: colors.muted, fontSize: 10, letterSpacing: 1.4, textTransform: "uppercase",
    fontWeight: "700", marginTop: 22,
  },
  panel: {
    marginTop: 10, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line,
    borderRadius: 16, padding: 14,
  },
  empty: { color: colors.muted, fontSize: 13 },
  row: {
    flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: colors.panel2,
    borderWidth: 1, borderColor: colors.line, borderRadius: 14, paddingVertical: 10,
    paddingHorizontal: 14, marginBottom: 8,
  },
  address: { flex: 1, color: colors.text, fontFamily: "monospace", fontSize: 13 },
  activeTag: {
    color: colors.yes, fontSize: 9, letterSpacing: 1.2, fontWeight: "700",
    textTransform: "uppercase",
  },
  useBtn: {
    backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: 12,
    paddingVertical: 7, paddingHorizontal: 14,
  },
  useBtnText: { color: colors.energy, fontWeight: "700", fontSize: 12 },
  balanceRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    marginTop: 4, marginBottom: 12,
  },
  balance: { color: colors.text, fontFamily: "monospace", fontSize: 15, fontWeight: "700" },
  refreshText: { color: colors.energy, fontWeight: "700", fontSize: 12 },
  connectBtn: {
    backgroundColor: colors.energy, borderRadius: 14, paddingVertical: 13, alignItems: "center",
  },
  connectBtnText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  footer: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 12 },
});
