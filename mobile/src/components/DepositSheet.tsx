// DepositSheet (native) — port of src/app/screens/DepositSheet.tsx. A network has to be CHOSEN before
// an address is shown: each address belongs to one chain and is meaningless off it. Opening the sheet
// declares the funding attempt (so the server watches for the deposit) and snapshots the balance, so
// "Deposit received" fires only on a real increase.
import { useEffect, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import type { Api } from "../api";
import { colors } from "../theme";

export type DepositChain = {
  chainId: string;
  name: string;
  address: string;
  minUsd: number;
  stables: string[];
};

export function DepositSheet({ visible, api, pusdMicro, onClose, onToast }: {
  visible: boolean;
  api: Api;
  // The balance the app already polls for the HUD. This sheet does NOT fetch it again: two watchers
  // on one number would be two RPC reads to say the same thing.
  pusdMicro: string | null;
  onClose: () => void;
  onToast: (msg: string) => void;
}) {
  const [chains, setChains] = useState<DepositChain[] | null>(null);
  const [picked, setPicked] = useState<DepositChain | null>(null);
  const [failed, setFailed] = useState(false);
  // What the balance was when this sheet opened. An ARRIVAL is an increase over THAT — not simply a
  // non-zero balance, or opening a funded account would announce money that came days ago.
  const [baseline, setBaseline] = useState<bigint | null>(null);
  const announced = useRef(false);
  // Declaring the attempt is what makes the SERVER watch this deposit: it snapshots the balance
  // baseline and starts the Transfer-log scan. Without it the bridge lands USDC.e that the pUSD
  // number never shows, nothing offers the conversion, and this sheet says "Watching…" forever.
  // Idempotent server-side: one active attempt per user.
  const declared = useRef(false);
  const current = pusdMicro == null ? null : BigInt(pusdMicro);
  const landed = current !== null && baseline !== null && current > baseline;

  // Every opening starts clean: a Modal stays mounted between openings, so per-opening state resets here.
  useEffect(() => {
    if (!visible) return;
    setChains(null);
    setPicked(null);
    setFailed(false);
    setBaseline(null);
    announced.current = false;
    declared.current = false;
  }, [visible]);

  useEffect(() => {
    if (visible && current !== null && baseline === null) setBaseline(current);
  }, [visible, current, baseline]);

  useEffect(() => {
    if (landed && !announced.current) {
      announced.current = true;
      onToast("Deposit received");
    }
  }, [landed, onToast]);

  useEffect(() => {
    if (!picked || declared.current) return;
    declared.current = true;
    api("/api/real/funding", { method: "POST", body: "{}" }).catch(() => {
      declared.current = false; // transient failure — the next network pick retries
    });
  }, [picked, api]);

  useEffect(() => {
    if (!visible) return;
    let live = true;
    // POST: the route only exports POST — it calls the bridge and caches per wallet.
    api("/api/real/deposit-address", { method: "POST" })
      .then((r) => {
        if (live) setChains(((r as { chains?: DepositChain[] }).chains ?? []).filter((c) => c.address));
      })
      .catch(() => {
        // The bridge mints these addresses. When it is unreachable there is nothing to show, and
        // inventing a fallback would be an invitation to send funds nowhere.
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [api, visible]);

  const copy = async (value: string) => {
    try {
      await Clipboard.setStringAsync(value);
      onToast("Copied to clipboard");
    } catch {
      onToast("Couldn't copy — select it manually");
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close">
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.handle} />
          <ScrollView showsVerticalScrollIndicator={false}>
            <View style={styles.header}>
              <Text style={styles.title}>{picked ? picked.name : "Deposit"}</Text>
              <TouchableOpacity onPress={picked ? () => setPicked(null) : onClose} style={styles.headerBtn}>
                <Text style={styles.headerBtnText}>{picked ? "Back" : "Close"}</Text>
              </TouchableOpacity>
            </View>

            {failed ? (
              <Text style={[styles.muted, styles.failedText]}>
                Deposit addresses are unavailable right now. Try again in a minute.
              </Text>
            ) : !chains ? (
              <Text style={[styles.muted, styles.loadingText]}>Loading networks…</Text>
            ) : picked ? (
              <>
                <Text style={[styles.caps, styles.sectionTop]}>Send to this address</Text>
                <TouchableOpacity onPress={() => void copy(picked.address)} style={styles.addressBtn}>
                  <Text selectable style={styles.addressText}>{picked.address}</Text>
                  <Text style={[styles.caps, styles.tapToCopy]}>Tap to copy</Text>
                </TouchableOpacity>

                <Row label="Network" value={picked.name} />
                <Row label="Send" value={picked.stables.length ? picked.stables.join(", ") : "USDC"} />
                <Row label="Minimum" value={`$${picked.minUsd}`} />

                {/* The two things that lose money here, stated where the address is, not in a footer. */}
                <Text style={[styles.muted, styles.warnText]}>
                  This address only works on{" "}
                  <Text style={{ color: colors.text, fontWeight: "700" }}>{picked.name}</Text>. Sending
                  from another network, or sending less than ${picked.minUsd}, means the funds do not arrive.
                </Text>
                <Text style={[styles.muted, styles.warnText2]}>
                  Anything you send is bridged to Polygon and converted to pUSD, the collateral Polymarket
                  trades in. It shows up as your real balance once the network confirms — usually a minute
                  or two.
                </Text>
                <Text style={[styles.status, { color: landed ? colors.yes : colors.muted }]}>
                  {landed ? "Deposit received — your balance is updated." : "Watching for your deposit…"}
                </Text>
              </>
            ) : (
              <>
                <Text style={[styles.muted, styles.chooseText]}>
                  Choose the network you are sending from. Each one has its own address — they are not
                  interchangeable.
                </Text>
                <View style={styles.chainList}>
                  {chains.map((c) => (
                    <TouchableOpacity key={c.chainId} onPress={() => setPicked(c)} style={styles.chainBtn}>
                      <View style={styles.chainInfo}>
                        <Text style={styles.chainName}>{c.name}</Text>
                        <Text style={[styles.muted, styles.chainStables]} numberOfLines={1}>
                          {c.stables.length ? c.stables.join(" · ") : "USDC"}
                        </Text>
                      </View>
                      <Text style={[styles.muted, styles.chainMin]}>min ${c.minUsd}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.caps, styles.rowLabel]}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(4,4,8,0.72)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: colors.bg2, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    borderTopWidth: 1, borderTopColor: colors.line, paddingHorizontal: 18, paddingBottom: 22, paddingTop: 8,
    maxHeight: "88%",
  },
  handle: { width: 42, height: 5, borderRadius: 4, backgroundColor: colors.line, alignSelf: "center", marginBottom: 14 },
  header: { flexDirection: "row", alignItems: "center", gap: 10 },
  title: { color: colors.text, fontSize: 20, fontWeight: "800", flex: 1 },
  headerBtn: { borderWidth: 1, borderColor: colors.line, borderRadius: 10, paddingVertical: 6, paddingHorizontal: 12 },
  headerBtnText: { color: colors.muted, fontSize: 12 },
  caps: { fontSize: 10, letterSpacing: 1.4, textTransform: "uppercase", color: colors.muted, fontWeight: "700" },
  muted: { fontSize: 12, color: colors.muted },
  failedText: { marginTop: 16, color: colors.no },
  loadingText: { marginTop: 16 },
  sectionTop: { marginTop: 16 },
  addressBtn: {
    marginTop: 8, backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.line,
    borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14,
  },
  addressText: { color: colors.text, fontSize: 13, fontFamily: "monospace", lineHeight: 18 },
  tapToCopy: { marginTop: 6, color: colors.gold },
  warnText: { marginTop: 14, lineHeight: 18 },
  warnText2: { marginTop: 8, lineHeight: 18 },
  status: { marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.line, fontSize: 12, fontWeight: "700" },
  chooseText: { marginTop: 10, lineHeight: 18 },
  chainList: { marginTop: 12 },
  chainBtn: {
    marginBottom: 8, flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: 12,
    paddingVertical: 11, paddingHorizontal: 14,
  },
  chainInfo: { flex: 1, minWidth: 0 },
  chainName: { color: colors.text, fontSize: 13, fontWeight: "700" },
  chainStables: { marginTop: 2 },
  chainMin: { flexShrink: 0 },
  row: { flexDirection: "row", gap: 10, alignItems: "baseline", marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.line },
  rowLabel: { flex: 1 },
  rowValue: { color: colors.text, fontSize: 13, fontWeight: "700", textAlign: "right", minWidth: 0 },
});
