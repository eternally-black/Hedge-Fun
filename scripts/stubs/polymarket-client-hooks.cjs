// Make every `@polymarket/client` require (root, /actions, /node) answer with the stub for the rest of
// this process, by seeding require.cache under the SDK's own resolved filenames. Import this module
// BEFORE the route under test. Why the cache and not a module.registerHooks resolve hook: with a sync
// resolve hook installed, Node's CJS loader takes a different resolution path from tsx's own alias
// patch, and `@/lib/helius` came back as a second module instance next to `../helius` — so a
// HeliusUnavailableError thrown by one failed `instanceof` in the other and the route rethrew.
// Seeding the cache leaves resolution exactly as tsx does it. tsx runs these tests as CJS (no
// "type": "module"), so every SDK import in the route graph is a require and hits the cache.
const Module = require("node:module");
const stub = require("./polymarket-client.cjs");

for (const spec of ["@polymarket/client", "@polymarket/client/actions", "@polymarket/client/node"]) {
  const filename = require.resolve(spec);
  const m = new Module(filename, module);
  m.filename = filename;
  m.loaded = true;
  m.exports = stub;
  require.cache[filename] = m;
}

module.exports = stub;
