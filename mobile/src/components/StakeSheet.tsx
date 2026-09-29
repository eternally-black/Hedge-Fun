// StakeSheet (native) — port of src/app/screens/StakeSheet.tsx. How much one real swipe spends,
// opened from the STAKE chip on the card itself.
//
// It edits the number the server will actually debit (users.realStakeCents) — /api/real/intent reads
// the stake from the row and only ever lowers it on request, so a stale client can never be the thing
// that decides an amount. Saving happens on an explicit choice, not on every keystroke: a half-typed
// "1" on the way to "10" must never become the stake someone swipes with.
import { useEffect, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import type { Api } from "../api";
import { colors } from "../theme";
import { REAL_STAKE_PRESETS_CENTS } from "../../lib/config";

const asDollars = (cents: number) => (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2));

export function StakeSheet({ visible, stakeCents, minCents, maxCents, api, onClose, onSaved, onToast }: {
  visible: boolean;
  stakeCents: number;
  minCents: number;
  maxCents: number;
  api: Api;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onToast: (msg: string) => void;
}) {
  const [draft, setDraft] = useState(() => asDollars(stakeCents));
  const [busy, setBusy] = useState(false);

  // Every opening starts from the account's CURRENT stake: a Modal stays mounted between openings,
  // so a draft abandoned last time must not be the number this time.
  useEffect(() => {
    if (!visible) return;
    setDraft(asDollars(stakeCents));
    setBusy(false);
  }, [visible, stakeCents]);

  const parsed = Math.round(Number(draft) * 100);
  const valid = draft.trim() !== "" && Number.isFinite(parsed) && parsed >= minCents && parsed <= maxCents;

  const save = async (cents: number) => {
    if (busy) return;
    if (cents === stakeCents) return onClose(); // nothing to write; closing IS the outcome
    setBusy(true);
    try {
      await api("/api/real/stake", { method: "POST", body: JSON.stringify({ stakeCents: cents }) });
      await onSaved();
      onClose();
    } catch {
      onToast("Couldn't save the stake");
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close">
        <Pressable style={styles.dialog} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.title}>Stake per swipe</Text>
          <Text style={styles.blurb}>
            Every call buys this much of the market. The platform fee is charged on top, so the total
            debit is slightly more than the stake.
          </Text>

          <View style={styles.presetRow}>
            {REAL_STAKE_PRESETS_CENTS.map((preset) => {
              const on = parsed === preset;
              return (
                <TouchableOpacity
                  key={preset}
                  disabled={busy}
                  onPress={() => setDraft(asDollars(preset))}
                  style={[styles.preset, on ? styles.presetOn : styles.presetOff]}
                >
                  <Text style={[styles.presetText, { color: on ? "#1a1205" : colors.text }]}>${asDollars(preset)}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <View style={styles.inputRow}>
            <Text style={styles.dollar}>$</Text>
            <TextInput
              keyboardType="decimal-pad"
              autoFocus
              value={draft}
              editable={!busy}
              // Digits and one dot only — the server takes integer cents, and a stray character here
              // would otherwise surface as a generic 400 on an amount the user thought they had typed.
              onChangeText={(t) => setDraft(t.replace(/[^0-9.]/g, ""))}
              onSubmitEditing={() => { if (valid) void save(parsed); }}
              style={[styles.input, { borderColor: valid || draft.trim() === "" ? colors.line : colors.no }]}
            />
          </View>

          <Text style={styles.range}>
            {valid || draft.trim() === ""
              ? `Between $${asDollars(minCents)} and $${asDollars(maxCents)}.`
              : `Enter between $${asDollars(minCents)} and $${asDollars(maxCents)}.`}
          </Text>

          <View style={styles.btnRow}>
            <TouchableOpacity onPress={busy ? undefined : onClose} disabled={busy} style={[styles.btn, styles.cancelBtn]}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={valid && !busy ? () => void save(parsed) : undefined}
              disabled={!valid || busy}
              style={[styles.btn, styles.saveBtn, { opacity: valid && !busy ? 1 : 0.5 }]}
            >
              <Text style={styles.saveText}>{busy ? "Saving…" : "Set stake"}</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(4,4,8,0.7)", alignItems: "center", justifyContent: "center", padding: 18 },
  dialog: {
    width: "100%", maxWidth: 330, backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.line,
    borderRadius: 20, paddingHorizontal: 18, paddingTop: 18, paddingBottom: 16,
  },
  title: { color: colors.text, fontSize: 19, lineHeight: 23, fontWeight: "800" },
  blurb: { marginTop: 6, fontSize: 12, color: colors.muted, lineHeight: 17 },
  presetRow: { flexDirection: "row", gap: 6, marginTop: 14 },
  preset: { flex: 1, paddingVertical: 10, borderRadius: 12, borderWidth: 1, alignItems: "center" },
  presetOn: { backgroundColor: colors.gold, borderColor: colors.gold },
  presetOff: { backgroundColor: colors.panel2, borderColor: colors.line },
  presetText: { fontWeight: "700", fontSize: 13 },
  inputRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 12 },
  dollar: { fontSize: 20, fontWeight: "700", color: colors.muted },
  input: {
    flex: 1, minWidth: 0, fontSize: 20, fontWeight: "700", color: colors.text, backgroundColor: colors.panel2,
    borderWidth: 1, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12,
  },
  range: { marginTop: 8, fontSize: 12, color: colors.muted },
  btnRow: { flexDirection: "row", gap: 8, marginTop: 16 },
  btn: { flex: 1, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 12, alignItems: "center" },
  cancelBtn: { backgroundColor: "transparent", borderWidth: 1, borderColor: colors.line },
  cancelText: { color: colors.muted, fontWeight: "700", fontSize: 13 },
  saveBtn: { backgroundColor: colors.gold },
  saveText: { color: "#1a1205", fontWeight: "700", fontSize: 13 },
});
