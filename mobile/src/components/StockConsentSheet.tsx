// StockConsentSheet (native) — the ONE sheet that carries the xStocks terms, limitations and the self-declaration.
// Ported from src/app/screens/StockConsentSheet.tsx (copy verbatim — the owner rule is that limitations live here
// and nowhere else).
import { useState } from "react";
import { Linking, Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { colors } from "../theme";

// The checkbox is the point. This is a self-declaration that the user is not a US person and not in
// a restricted jurisdiction — a claim only they can make, and one the button must not make for them.
export function StockConsentSheet({ open, busy, sponsored, mode = "consent", onAccept, onClose }: {
  open: boolean;
  busy: boolean;
  /** The server pays the Solana network fee for these swaps — say so before the user agrees. */
  sponsored?: boolean;
  /**
   * "consent" gates a trade behind the self-declaration. "info" is the SAME text opened from a
   * ⓘ button: nothing is being agreed to, so there is no checkbox to tick and no way to get
   * trapped reading it — the one button just closes.
   */
  mode?: "consent" | "info";
  onAccept: () => void | Promise<void>;
  onClose: () => void;
}) {
  // RN's Modal unmounts its children while hidden, so the body (and its tick) mounts fresh on every
  // open: re-opening the sheet never remembers a previous tick — the declaration is per-acceptance.
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <SheetBody busy={busy} sponsored={sponsored} mode={mode} onAccept={onAccept} onClose={onClose} />
    </Modal>
  );
}

function SheetBody({ busy, sponsored, mode, onAccept, onClose }: { busy: boolean; sponsored?: boolean; mode: "consent" | "info"; onAccept: () => void | Promise<void>; onClose: () => void }) {
  const [checked, setChecked] = useState(false);
  const info = mode === "info";
  const blocked = busy || (!info && !checked);

  return (
    <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close">
      <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
        <View style={styles.handle} />
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          <Text style={styles.title}>Buying real stocks on Solana</Text>

          <Text style={styles.body}>
            These are tokenized stocks (xStocks by Backed). You buy them in YOUR own wallet through
            Jupiter — HedgeFun never holds your funds and cannot sell for you.
          </Text>
          <Text style={styles.body}>
            Stock cards are thematic exposure, not a hedge of your actual bill — a fare or a fuel price
            can rise while the stock falls. &apos;Energy stocks&apos; cards track an energy-equity basket
            (XLEx), not crude oil. Sizing is a product rule, not hedge math.
          </Text>
          {sponsored ? (
            <Text style={styles.body}>
              Network fees for these swaps are paid by HedgeFun.
            </Text>
          ) : null}
          <Text style={styles.body}>
            xStocks are not available to US persons or in restricted jurisdictions.
          </Text>

          {info ? (
            // Reading the terms is not accepting them: the self-declaration belongs to the trade.
            <Text style={styles.body}>
              You&apos;ll be asked to confirm this before your first buy. Full{" "}
              <Text style={styles.link} onPress={() => Linking.openURL("https://xstocks.com/terms")}>
                xStocks terms
              </Text>
              .
            </Text>
          ) : (
            <Pressable style={styles.checkRow} onPress={() => setChecked((c) => !c)} accessibilityRole="checkbox" accessibilityState={{ checked }}>
              <Text style={styles.checkBox}>{checked ? "☑" : "☐"}</Text>
              <Text style={styles.checkLabel}>
                I am not a US person and not in a restricted jurisdiction, and I accept the{" "}
                <Text style={styles.link} onPress={() => Linking.openURL("https://xstocks.com/terms")}>
                  xStocks terms
                </Text>
              </Text>
            </Pressable>
          )}
        </ScrollView>

        <View style={styles.actions}>
          <TouchableOpacity
            onPress={blocked ? undefined : onAccept}
            disabled={blocked}
            style={[styles.acceptBtn, blocked && styles.acceptBtnDisabled]}
          >
            <Text style={styles.acceptText}>{busy ? "Saving…" : info ? "Got it" : "I understand, continue"}</Text>
          </TouchableOpacity>
          {/* In info mode "Got it" IS the dismiss — a second button that also closes is noise. */}
          {info ? null : (
            <TouchableOpacity
              onPress={busy ? undefined : onClose}
              disabled={busy}
              style={[styles.cancelBtn, busy && styles.cancelBtnDisabled]}
            >
              <Text style={styles.cancelText}>Not now</Text>
            </TouchableOpacity>
          )}
        </View>
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(4,4,8,0.66)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: colors.bg2, borderTopLeftRadius: 22, borderTopRightRadius: 22,
    borderTopWidth: 1, borderTopColor: colors.line, paddingHorizontal: 18, paddingBottom: 22, paddingTop: 8,
  },
  handle: { width: 42, height: 5, borderRadius: 4, backgroundColor: colors.line, alignSelf: "center", marginBottom: 14 },
  scroll: { maxHeight: 420 },
  scrollContent: { paddingBottom: 4 },
  title: { color: colors.text, fontSize: 20, fontWeight: "700", lineHeight: 24 },
  body: { color: colors.muted, fontSize: 12, marginTop: 10, lineHeight: 19 },
  link: { color: colors.energy, textDecorationLine: "underline" },
  checkRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginTop: 16 },
  checkBox: { color: colors.energy, fontSize: 16, lineHeight: 18, marginTop: 1 },
  checkLabel: { flex: 1, color: colors.text, fontSize: 12, lineHeight: 18 },
  actions: { marginTop: 18, gap: 8 },
  acceptBtn: { paddingVertical: 13, paddingHorizontal: 16, borderRadius: 14, backgroundColor: colors.energy, alignItems: "center" },
  acceptBtnDisabled: { opacity: 0.5 },
  acceptText: { color: "#06070a", fontWeight: "800", fontSize: 14 },
  cancelBtn: { paddingVertical: 12, paddingHorizontal: 16, borderRadius: 14, borderWidth: 1, borderColor: colors.line, alignItems: "center" },
  cancelBtnDisabled: { opacity: 0.5 },
  cancelText: { color: colors.muted, fontWeight: "700", fontSize: 13 },
});
