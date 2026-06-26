// Self-checks for the reveal's peak-end ordering (DB-free, pure).
// The featured run plays ≤max cards and must END on the biggest win (dopamine peak).
// Run: npx tsx scripts/test-reveal-order.ts
import assert from "node:assert";
import type { ResultRow } from "../src/lib/api-types";
import { peakEndOrder } from "../src/app/screens/RevealOverlay";

// Minimal row factory — only the fields peakEndOrder reads matter.
const row = (id: string, status: ResultRow["status"], deltaCents: number): ResultRow => ({
  id, question: id, category: null, side: "YES", sideLabel: "Yes",
  status, outcome: "", pnlCents: deltaCents, deltaCents, shards: status === "WIN" ? 1 : 0,
  settledAt: "2026-06-26T00:00:00.000Z", seen: false,
});

// ---- ends on the biggest win ----
const rows = [
  row("a", "WIN", 120_00),
  row("b", "LOSS", -100_00),
  row("c", "WIN", 85_00),
  row("d", "PUSH", 0),
  row("e", "WIN", 235_00), // biggest win
];
const out = peakEndOrder(rows, 5);
assert.strictEqual(out.length, 5, "keeps all five (== max)");
assert.strictEqual(out[out.length - 1].id, "e", "ends on the biggest win (+235)");

// ---- honors the max cap, finale still last ----
const capped = peakEndOrder(rows, 3);
assert.strictEqual(capped.length, 3, "respects max=3");
assert.strictEqual(capped[capped.length - 1].id, "e", "biggest win is still the finale when capped");
assert.ok(!capped.slice(0, -1).some((r) => r.id === "e"), "finale appears exactly once");

// ---- no wins: just the most-recent slice, unchanged tail ----
const losses = [row("x", "LOSS", -100_00), row("y", "PUSH", 0), row("z", "LOSS", -50_00)];
const lo = peakEndOrder(losses, 5);
assert.strictEqual(lo.length, 3, "all losses kept");
assert.strictEqual(lo[0].id, "x", "order preserved when there's no win to hoist");

// ---- trivial sizes ----
assert.strictEqual(peakEndOrder([], 5).length, 0, "empty -> empty");
assert.deepStrictEqual(peakEndOrder([row("only", "WIN", 10_00)], 5).map((r) => r.id), ["only"], "single row -> itself");

console.log("test-reveal-order: OK");
