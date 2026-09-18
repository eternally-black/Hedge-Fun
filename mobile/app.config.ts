// Expo config — ONE project, TWO flavors, chosen at build time by APP_FLAVOR (docs/shipaton.md §4).
//
//   seeker (default) — Solana dApp Store APK for the Seeker phone: Mobile Wallet Adapter, real money.
//   play             — Google Play AAB: paper economy only, RevenueCat Pro, no wallet code path.
//
// Different android.package per flavor on purpose: Play re-signs bundles with its own key, so a
// dApp-Store APK signed with ours could never install over a Play install of the same package name
// (E2 in docs/play-traps.uk.md). The flavor is also what mobile/metro.config.js uses to pick
// `x.<flavor>.ts` for every `x.flavor` import, and what src/platform/flavor.ts reads at runtime.
import type { ConfigContext, ExpoConfig } from "expo/config";

export type Flavor = "seeker" | "play";
export const FLAVOR: Flavor = process.env.APP_FLAVOR === "play" ? "play" : "seeker";

const ANDROID_PACKAGE: Record<Flavor, string> = {
  seeker: "fun.hedgeyour.seeker",
  play: "fun.hedgeyour.app",
};

const appConfig = ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "Hedge Fun",
  slug: "hedge-fun",
  version: "0.1.0",
  orientation: "portrait",
  scheme: "hedgefun",
  icon: "./assets/icon.png",
  userInterfaceStyle: "dark",
  backgroundColor: "#0a0a0f",
  ios: {
    supportsTablet: true,
    bundleIdentifier: "fun.hedgeyour.app",
  },
  android: {
    package: ANDROID_PACKAGE[FLAVOR],
    adaptiveIcon: {
      backgroundColor: "#0a0a0f",
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
    predictiveBackGestureEnabled: false,
  },
  plugins: ["./plugins/withShareQueries"],
  extra: { flavor: FLAVOR },
  web: { favicon: "./assets/favicon.png" },
});

export default appConfig;
