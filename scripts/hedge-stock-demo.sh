#!/usr/bin/env bash
# Prints the three Stocklana demo lines against a running HedgeFun (default: prod).
# Usage: HF_TOKEN=<privy access token> [HF_BASE=https://app.hedgeyour.fun] bash scripts/hedge-stock-demo.sh
set -euo pipefail
BASE="${HF_BASE:-https://app.hedgeyour.fun}"
: "${HF_TOKEN:?set HF_TOKEN to a Privy access token (DevTools → Application → privy:token)}"
say() { # $1 = text, $2 = amountCents (optional)
  local body
  if [ -n "${2:-}" ]; then body="{\"text\":\"$1\",\"amountCents\":$2}"; else body="{\"text\":\"$1\"}"; fi
  curl -sS "$BASE/api/hedge/search" -H "Authorization: Bearer $HF_TOKEN" -H "Content-Type: application/json" -d "$body" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);for(const c of j.stockSuggestions??[])console.log(`${c.stock.symbol.padEnd(6)} $${(c.proposedStakeCents/100).toFixed(2).padStart(7)}  ${c.rationale}`);if(!(j.stockSuggestions??[]).length)console.log("(no stock card)",JSON.stringify(j).slice(0,200));})'
}
echo "== \$800 on flights this month =="; say "\$800 on flights this month"
echo "== I drive ~1,000 km/month ==";     say "I drive ~1000 km a month"
echo "== spotted today (wallet + live moves) =="
curl -sS "$BASE/api/hedge/spotted" -H "Authorization: Bearer $HF_TOKEN" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);for(const c of j.suggestions??[])console.log(`${c.stock.symbol.padEnd(6)} $${(c.proposedStakeCents/100).toFixed(2).padStart(7)}  ${c.rationale}`);if(!(j.suggestions??[]).length)console.log("(nothing spotted — no trigger crossed today)");})'
