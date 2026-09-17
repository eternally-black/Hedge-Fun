// Metro config — Expo defaults plus three resolver rules:
//   1. `@contract/<file>` → mobile/contract/<file>, the GENERATED copy of src/lib/<file> (Metro cannot
//      bundle files outside mobile/; scripts/sync-mobile-contract.ts writes the copies, CI checks them).
//   2. `<module>.flavor` → `<module>.<APP_FLAVOR>`: platform ports (purchases, signer, walletLink)
//      resolve to the flavor's file at bundle time, so the other flavor's code is not in the bundle.
//   3. The package-exports overrides the Privy RN SDK requires (docs.privy.io/basics/react-native).
/* eslint-disable @typescript-eslint/no-require-imports -- Metro config is CommonJS by design */
const fs = require("fs");
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const FLAVOR = process.env.APP_FLAVOR === "play" ? "play" : "seeker"; // mirrors app.config.ts
const CONTRACT_DIR = path.join(__dirname, "contract");

const config = getDefaultConfig(__dirname);

const resolveRequest = (context, moduleName, platform) => {
  // `@contract/x` → mobile/contract/x.ts(x): answered directly (a Resolution object), not via
  // node_modules lookup — a scoped name would otherwise be searched as the package "@contract/x".
  if (moduleName.startsWith("@contract/")) {
    const base = path.join(CONTRACT_DIR, moduleName.slice("@contract/".length));
    for (const ext of [".ts", ".tsx"]) {
      if (fs.existsSync(base + ext)) return { type: "sourceFile", filePath: base + ext };
    }
    throw new Error(`@contract: ${moduleName} is not a file in ${CONTRACT_DIR}`);
  }
  if (moduleName.endsWith(".flavor")) {
    return context.resolveRequest(context, `${moduleName.slice(0, -".flavor".length)}.${FLAVOR}`, platform);
  }

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

config.resolver.resolveRequest = resolveRequest;

module.exports = config;
