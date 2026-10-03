// `npm audit --audit-level=high` with a reviewed allowlist. Fails on any high/critical advisory not
// listed below. Usage: node scripts/audit-gate.mjs <prefix>
import { execSync } from "node:child_process";

// Each entry: no patched version exists AND the package is reachable only through build tooling,
// never through the shipped bundle. Re-check on every Expo bump; delete once a fix ships.
const ALLOW = new Map([
  // braces (all versions) — expo > @expo/cli > @expo/metro-file-map > micromatch. Metro build-time.
  ["https://github.com/advisories/GHSA-vfj7-8cjw-p6xm", "2026-10-03 no fix; @expo/cli build tool only"],
  // node-forge (all versions) — expo > @expo/cli (+ code-signing-certificates). CLI-only.
  ["https://github.com/advisories/GHSA-86w9-cpqp-85rv", "2026-10-03 no fix; @expo/cli build tool only"],
]);

const prefix = process.argv[2] ?? ".";
let out;
try {
  out = execSync(`npm audit --prefix ${prefix} --omit=dev --json`, { encoding: "utf8", maxBuffer: 64 << 20 });
} catch (e) {
  out = e.stdout; // npm audit exits non-zero when it finds anything
}
const seen = new Map();
for (const v of Object.values(JSON.parse(out).vulnerabilities ?? {}))
  for (const x of v.via) if (typeof x === "object") seen.set(x.url, `${x.severity} ${x.name}: ${x.title}`);

const blocking = [...seen].filter(([url, d]) => /^(high|critical) /.test(d) && !ALLOW.has(url));
for (const [url, d] of seen) console.log(`${ALLOW.has(url) ? "allowed " : ""}${d} ${url}`);
if (blocking.length) {
  console.error(`${prefix}: ${blocking.length} blocking advisory(ies)`);
  process.exit(1);
}
console.log(`${prefix}: audit gate passed`);
