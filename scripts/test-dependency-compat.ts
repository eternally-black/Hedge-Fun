import assert from "node:assert/strict";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { Connection, PublicKey } from "@solana/web3.js";
import { loadConfigFromFile } from "@prisma/config";

const requireFromHere = createRequire(import.meta.url);

async function main() {
  // Exercise web3.js's actual Jayson browser client, including generated request IDs.
  // No request leaves this injected transport.
  const methods: string[] = [];
  const connection = new Connection("http://127.0.0.1:1", {
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      assert.equal(request.jsonrpc, "2.0");
      assert.equal(typeof request.id, "string");
      methods.push(request.method);
      const result = request.method === "getBalance"
        ? { context: { slot: 123 }, value: 42 }
        : request.method === "getLatestBlockhash"
          ? { context: { slot: 123 }, value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 200 } }
          : null;
      assert.notEqual(result, null, "unexpected network method");
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(await connection.getBalance(new PublicKey("11111111111111111111111111111111")), 42);
  assert.equal((await connection.getLatestBlockhash()).lastValidBlockHeight, 200);
  assert.deepEqual(methods, ["getBalance", "getLatestBlockhash"]);

  // Prisma's config loader invokes deepmerge through c12. Use a temporary explicit
  // configuration; the loader disables dotenv and never connects to a database.
  const directory = await mkdtemp(path.join(tmpdir(), "hedgefun-dependency-test-"));
  const configFile = path.join(directory, "prisma.config.js");
  try {
    const modulePath = requireFromHere.resolve("@prisma/config");
    await writeFile(configFile,
      `const { defineConfig } = require(${JSON.stringify(modulePath)});\n` +
      "module.exports = defineConfig({ schema: 'schema.prisma', migrations: { path: 'migrations' } });\n");
    const loaded = await loadConfigFromFile({ configRoot: directory, configFile });
    assert.equal(loaded.error, undefined, "Prisma config must load with the patched merge library");
    assert.equal(loaded.config.schema, path.join(directory, "schema.prisma"));
    assert.equal(loaded.config.migrations?.path, path.join(directory, "migrations"));
  } finally {
    await unlink(configFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await rmdir(directory);
  }

  // The Expo build-tool override retains xcode's UUID format and generator API.
  if (process.argv.includes("--mobile")) {
    const mobileRequire = createRequire(path.resolve("mobile/package.json"));
    const xcode = mobileRequire("xcode");
    const project = xcode.project("unused.pbxproj");
    project.hash = { project: { objects: {} } };
    const ids = new Set(Array.from({ length: 100 }, () => project.generateUuid()));
    assert.equal(ids.size, 100);
    for (const id of ids) assert.match(String(id), /^[A-F0-9]{24}$/);
  }

  console.log(`dependency compatibility: Solana JSON-RPC and Prisma config passed${process.argv.includes("--mobile") ? "; Expo UUIDs passed" : ""}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
