// The mobile app's copy of the API contract. Metro cannot bundle files outside mobile/ (verified
// 2026-09-17: watchFolders does not make ../src/lib resolvable in this project), so the shared files
// — the API contract plus the real-money client closure the phone reuses verbatim — are GENERATED
// into mobile/contract/ and committed. This script is the only writer; CI runs it with --check and
// fails when a copy has drifted from src/ (docs/shipaton.md §4.2).
//
//   npm run contract:sync    regenerate mobile/contract/*
//   npm run contract:check   exit 1 if any copy differs from what sync would write
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// dir is relative to src/. The first four are the API contract; the rest are real-client's import
// closure, which the phone reuses verbatim.
const FILES: { name: string; dir: string }[] = [
  { name: "api-types.ts", dir: "lib" },
  { name: "share.ts", dir: "lib" },
  { name: "time.ts", dir: "lib" },
  { name: "real-terms.ts", dir: "lib" },
  { name: "real-client.ts", dir: "lib" },
  { name: "real-signer.ts", dir: "lib" },
  { name: "relay-guard.ts", dir: "lib" },
  { name: "client-report.ts", dir: "lib" },
  { name: "wallet-ops.ts", dir: "lib" },
  { name: "polygon.ts", dir: "lib" },
  { name: "deadline.ts", dir: "lib" },
  { name: "real-copy.ts", dir: "app/screens" },
];
const OUT = join(__dirname, "..", "mobile", "contract");

const check = process.argv.includes("--check");
mkdirSync(OUT, { recursive: true });

let drift = 0;
for (const { name, dir } of FILES) {
  const body = readFileSync(join(__dirname, "..", "src", dir, name), "utf8");
  const want = `// GENERATED from src/${dir}/${name} by scripts/sync-mobile-contract.ts — do not edit here.\n${body}`;
  const dest = join(OUT, name);
  let have: string | null = null;
  try {
    have = readFileSync(dest, "utf8");
  } catch {
    have = null;
  }
  if (have === want) continue;
  drift++;
  if (check) {
    console.error(`mobile/contract/${name} is out of date — run: npm run contract:sync`);
  } else {
    writeFileSync(dest, want);
    console.log(`wrote mobile/contract/${name}`);
  }
}

if (check && drift) process.exit(1);
if (!drift) console.log("mobile/contract is in sync ✓");
