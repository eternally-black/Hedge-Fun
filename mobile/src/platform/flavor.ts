// Which flavor this binary IS — a build-time constant surfaced at runtime (app.config.ts → extra).
// Never a toggle: the Play bundle must not be able to reach real-money UI even by a flipped flag,
// so screens branch on FLAVOR only for cosmetics; the code that differs lives in `*.flavor` modules
// that Metro resolves to `*.<flavor>.ts` (mobile/metro.config.js).
import Constants from "expo-constants";

export type Flavor = "seeker" | "play";

export const FLAVOR: Flavor =
  (Constants.expoConfig?.extra as { flavor?: Flavor } | undefined)?.flavor === "play" ? "play" : "seeker";
