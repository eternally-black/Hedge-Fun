// Expo config plugin: adds Android manifest <queries> entries so Linking.canOpenURL works for the
// X/Telegram share deep-links (twitter://, tg://) on Android 11+ package-visibility rules.
// See docs/share-and-android.md §3 checklist. Runs at prebuild; referenced from app.json plugins.
/* eslint-disable @typescript-eslint/no-require-imports -- Expo config plugins are CommonJS by design */
const { withAndroidManifest } = require("expo/config-plugins");

/** @type {import("expo/config-plugins").ConfigPlugin} */
const withShareQueries = (config) =>
  withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest.queries = manifest.queries ?? [];
    const queries = manifest.queries;

    // Keep it idempotent — prebuild can run the plugin more than once.
    queries.intent = queries.intent ?? [];
    const schemes = new Set(
      queries.intent.flatMap((i) => (i.data ?? []).map((d) => d?.$?.["android:scheme"]).filter(Boolean)),
    );
    for (const scheme of ["twitter", "tg"]) {
      if (schemes.has(scheme)) continue;
      queries.intent.push({
        action: [{ $: { "android:name": "android.intent.action.VIEW" } }],
        data: [{ $: { "android:scheme": scheme } }],
      });
      schemes.add(scheme);
    }
    return cfg;
  });

module.exports = withShareQueries;
