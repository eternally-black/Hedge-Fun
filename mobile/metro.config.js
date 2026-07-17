// Metro config — extends Expo's defaults with the resolver overrides the Privy RN SDK requires
// (docs.privy.io/basics/react-native/installation). Package exports are ON by default in RN 0.79+/
// Expo 53+; these deps ship incompatible export maps and must be special-cased.
/* eslint-disable @typescript-eslint/no-require-imports -- Metro config is CommonJS by design */
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

const resolveRequestWithPackageExports = (context, moduleName, platform) => {
  // Package exports in `isows` (a `viem` dependency) are incompatible, so they need to be disabled
  if (moduleName === "isows") {
    const ctx = { ...context, unstable_enablePackageExports: false };
    return ctx.resolveRequest(ctx, moduleName, platform);
  }

  // Package exports in `zustand@4` are incompatible, so they need to be disabled
  if (moduleName.startsWith("zustand")) {
    const ctx = { ...context, unstable_enablePackageExports: false };
    return ctx.resolveRequest(ctx, moduleName, platform);
  }

  // Package exports in `jose` are incompatible, so the browser version is used
  if (moduleName === "jose") {
    const ctx = { ...context, unstable_conditionNames: ["browser"] };
    return ctx.resolveRequest(ctx, moduleName, platform);
  }

  return context.resolveRequest(context, moduleName, platform);
};

config.resolver.resolveRequest = resolveRequestWithPackageExports;

module.exports = config;
