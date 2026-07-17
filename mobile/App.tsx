import { PrivyProvider } from "@privy-io/expo";
import { StyleSheet, Text, View } from "react-native";
import { PRIVY_APP_ID, PRIVY_CLIENT_ID } from "./lib/config";
import { colors } from "./src/theme";
import Root from "./src/Root";

export default function App() {
  // Without credentials Privy can't init — show the config notice instead of crashing
  // (same pattern as the web client's NEXT_PUBLIC_PRIVY_APP_ID guard).
  if (!PRIVY_APP_ID) return <ConfigNotice />;
  return (
    <PrivyProvider appId={PRIVY_APP_ID} clientId={PRIVY_CLIENT_ID}>
      <Root />
    </PrivyProvider>
  );
}

function ConfigNotice() {
  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>Hedge Fun</Text>
      <Text style={styles.body}>
        Set EXPO_PUBLIC_PRIVY_APP_ID and EXPO_PUBLIC_PRIVY_CLIENT_ID in mobile/.env (see
        mobile/.env.example).
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center", padding: 28 },
  title: { color: colors.text, fontSize: 40, fontWeight: "900" },
  body: { color: colors.muted, marginTop: 12, textAlign: "center", fontSize: 13, lineHeight: 19 },
});
