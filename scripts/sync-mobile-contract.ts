// The mobile app's copy of the API contract. Metro cannot bundle files outside mobile/ (verified
// 2026-09-17: watchFolders does not make ../src/lib resolvable in this project), so the three shared
// files are GENERATED into mobile/contract/ and committed. This script is the only writer; CI runs
// it with --check and fails when a copy has drifted from src/lib (docs/shipaton.md §4.2).
//
//   npm run contract:sync    regenerate mobile/contract/*
//   npm run contract:check   exit 1 if any copy differs from what sync would write
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const FILES = ["api-types.ts", "share.ts", "time.ts"];
const SRC = join(__dirname, "..", "src", "lib");
const OUT = join(__dirname, "..", "mobile", "contract");

const check = process.argv.includes("--check");
mkdirSync(OUT, { recursive: true });

let drift = 0;
for (const name of FILES) {
  const body = readFileSync(join(SRC, name), "utf8");
  const want = `// GENERATED from src/lib/${name} by scripts/sync-mobile-contract.ts — do not edit here.\n${body}`;
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
