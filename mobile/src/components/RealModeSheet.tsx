// RealModeSheet (native) — the one-time notice in front of the account's Paper/Real switch. Dumb:
// it renders the CURRENT terms text and reports the tap; the caller records the acceptance (with
// the terms version) and flips the mode. The tick is local and resets whenever the sheet closes.
import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import {
  REAL_TERMS,
  REAL_TERMS_ACK,
  REAL_TERMS_INTRO,
  REAL_TERMS_TITLE,
  REAL_TERMS_VERSION,
} from "@contract/real-terms";
import { colors } from "../theme";

export function RealModeSheet({ open, busy, onAccept, onClose }: {
  open: boolean;
  busy: boolean;
  onAccept: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [ticked, setTicked] = useState(false);

  // Consent is per-presentation: closing (or reopening) the sheet always starts unticked.
  useEffect(() => {
    if (!open) setTicked(false);
  }, [open]);

  const canAccept = ticked && !busy;

  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close">
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.handle} />
          <Text style={styles.title}>{REAL_TERMS_TITLE}</Text>
          <Text style={styles.intro}>{REAL_TERMS_INTRO}</Text>

          <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollBody}>
            {REAL_TERMS.map((clause) => (
              <View key={clause.title} style={styles.clause}>
                <Text style={styles.clauseTitle}>{clause.title}</Text>
                <Text style={styles.clauseBody}>{clause.body}</Text>
              </View>
            ))}
          </ScrollView>

          <Pressable
            style={styles.ackRow}
            onPress={() => setTicked((t) => !t)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: ticked }}
            accessibilityLabel={REAL_TERMS_ACK}
          >
            <Text style={[styles.ackBox, ticked && styles.ackBoxOn]}>{ticked ? "☑" : "☐"}</Text>
            <Text style={styles.ackLabel}>{REAL_TERMS_ACK}</Text>
          </Pressable>

          <View style={styles.actions}>
            <TouchableOpacity style={[styles.btn, styles.btnGhost]} onPress={onClose} disabled={busy}>
              <Text style={[styles.btnText, { color: colors.muted }]}>Not now</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btn, styles.btnPrimary, !canAccept && styles.btnDisabled]}
              onPress={() => { void onAccept(); }}
              disabled={!canAccept}
            >
              <Text style={[styles.btnText, { color: canAccept ? colors.yes : colors.muted }]}>
                {busy ? "Turning on…" : "Turn on real money"}
              </Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.version}>Terms version {REAL_TERMS_VERSION}</Text>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(4,4,8,0.6)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: colors.bg2, borderTopLeftRadius: 28, borderTopRightRadius: 28,
    borderTopWidth: 1, borderTopColor: colors.line, paddingHorizontal: 18, paddingBottom: 28, paddingTop: 8,
  },
  handle: { width: 42, height: 5, borderRadius: 4, backgroundColor: colors.line, alignSelf: "center", marginBottom: 14 },
  title: { color: colors.text, fontSize: 20, fontWeight: "700" },
  intro: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 8 },
  scroll: { marginTop: 14, maxHeight: 320 },
  scrollBody: { paddingBottom: 4 },
  clause: { marginBottom: 14 },
  clauseTitle: { color: colors.text, fontSize: 14, fontWeight: "700" },
  clauseBody: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 4 },
  ackRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginTop: 6, paddingVertical: 6 },
  ackBox: { color: colors.muted, fontSize: 18, lineHeight: 22 },
  ackBoxOn: { color: colors.yes },
  ackLabel: { color: colors.text, fontSize: 13, lineHeight: 19, flex: 1 },
  actions: { flexDirection: "row", gap: 10, marginTop: 12 },
  btn: { flex: 1, paddingVertical: 13, borderRadius: 14, borderWidth: 1, alignItems: "center" },
  btnGhost: { backgroundColor: colors.panel2, borderColor: colors.line },
  btnPrimary: { backgroundColor: "rgba(182,255,46,0.16)", borderColor: "rgba(182,255,46,0.5)" },
  btnDisabled: { backgroundColor: colors.panel2, borderColor: colors.line, opacity: 0.6 },
  btnText: { fontWeight: "700", fontSize: 14 },
  version: { color: colors.muted, fontSize: 11, textAlign: "center", marginTop: 14 },
});
