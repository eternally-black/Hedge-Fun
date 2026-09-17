// Expo config plugin: adds Android manifest <queries> entries so Linking.canOpenURL works for the
// X/Telegram share deep-links (twitter://, tg://) on Android 11+ package-visibility rules.
// See docs/share-and-android.md §3 checklist. Runs at prebuild; referenced from app.json plugins.
/* eslint-disable @typescript-eslint/no-require-imports -- Expo config plugins are CommonJS by design */
const { withAndroidManifest } = require("expo/config-plugins");

/** @type {import("expo/config-plugins").ConfigPlugin} */
const withShareQueries = (config) =>
  withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    // xml2js shape: <queries> is an ARRAY of query blocks (one per tag), each { intent?, package?, provider? }.
    // Treating it as an object put an `intent` property on an array, which xmlbuilder then tried to
    // serialise as an element with an array index for a name -> "Invalid character in name" at prebuild.
    manifest.queries = manifest.queries ?? [];
    if (manifest.queries.length === 0) manifest.queries.push({});
    const queries = manifest.queries[0];

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
