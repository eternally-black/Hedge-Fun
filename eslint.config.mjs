import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// ESLint v9 flat config, Next 16 native exports (no FlatCompat — that path throws a circular-
// structure error against eslint-config-next@16). core-web-vitals = Next + React + React-hooks
// rules (exhaustive-deps, the one we care about for the React best-practices pass) with the
// Core Web Vitals rules promoted to errors; typescript layers typescript-eslint on top.
const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // "app design/" is the static design handoff (HTML mockups + an old support.js), not app code;
  // dist/ is the compiled poller. Neither is linted.
  globalIgnores([".next/**", "out/**", "build/**", "dist/**", "next-env.d.ts", "app design/**"]),
  // Allow intentionally-unused names when prefixed with _ (e.g. kept-for-signature params).
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // Next 16 ships the React-Compiler-era react-hooks rules at error. We don't run the React
      // Compiler, and these flag three DELIBERATE, valid patterns this codebase relies on:
      //  • refs: writing a "latest value" ref during render so stable callbacks read fresh state
      //    without depending on it (the use-latest pattern — see meRef/topRef in page.tsx).
      //  • set-state-in-effect: seeding a clock from Date.now() in an effect (can't read it during
      //    SSR render without a hydration mismatch) for the countdown tickers.
      //  • purity: Math.random() inside a useMemo keyed by row.id — runs once per card, positions
      //    fixed (the coin-burst fountain).
      // Kept as warnings (visible signal) rather than errors (which would wrongly block on intent).
      // exhaustive-deps stays an error — that's the rule that actually guards correctness.
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
    },
  },
  // Standalone tsx test/seed scripts: they mock SDK internals via `as any` and aren't shipped.
  {
    files: ["scripts/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
]);

export default eslintConfig;
