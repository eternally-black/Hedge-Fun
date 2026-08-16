// Live verification of the Polymarket CLOB /books integration (D10). Run: npm run verify:clob
// Hits the REAL CLOB (token ids discovered via the real Gamma) and asserts the contract
// src/lib/clob.ts depends on. Loud failure when Polymarket changes shape.
//
// Verified live 2026-07-26: a token with NO orders is OMITTED from the /books response entirely
// (re-requesting it alone still returns nothing); a few tokens come back as an explicit entry with
// both sides empty. Both spell "dead book" — src/lib/clob.ts negative-caches both, and step 2
// below pins the omission behaviour so a future shape change (e.g. positional responses, or empty
// books suddenly returned as zeros) fails loudly here instead of corrupting prices silently.
//
// The omission rate is expiry-dependent: books of markets resolving within seconds are already torn
// down while Gamma still lists them (a 2026-07-26 sample of the soonest-ending 200 tokens came back
// 104/200 omitted, while a >15min-out sample was 200/200 with 0 both-sides-empty). So the canary
// draws its token set from markets resolving MORE THAN 15 MINUTES OUT and asserts NEAR-FULL coverage
// there — that is the real contract. Imminent-expiry omissions are expected and NOT asserted.
import assert from "node:assert";
import { getBooks, postBooks } from "../src/lib/clob";

const GAMMA_BASE = process.env.POLYMARKET_API_BASE ?? "https://gamma-api.polymarket.com";
// The canary's universe: markets resolving further out than this. Nearer in, book teardown ahead of
// resolution makes /books omissions legitimate (see header), which would drown the signal.
const MIN_RESOLVE_LEAD_MS = 15 * 60_000;
// Coverage contract on that universe: near-full. A live book going missing en masse means Polymarket
// changed omission semantics — a 10%-style floor would sleep through exactly that regression.
const MIN_COVERAGE = 0.95;

interface GammaRow {
  conditionId?: string;
  question?: string;
  clobTokenIds?: string; // JSON string '["<yesToken>","<noToken>"]'
}

// Pull live binary markets with BOTH CLOB token ids (the same parse idiom mapMarket uses), restricted
// to markets resolving > MIN_RESOLVE_LEAD_MS out (end_date_min — Gamma filters server-side).
async function fetchTokenPairs(pages: number): Promise<{ conditionId: string; question: string; yesTokenId: string; noTokenId: string }[]> {
  const out: { conditionId: string; question: string; yesTokenId: string; noTokenId: string }[] = [];
  for (let page = 0; page < pages; page++) {
    const qs = new URLSearchParams({
      active: "true",
      closed: "false",
      end_date_min: new Date(Date.now() + MIN_RESOLVE_LEAD_MS).toISOString(),
      order: "endDate",
      ascending: "true",
      limit: "100",
      offset: String(page * 100),
    });
    const res = await fetch(`${GAMMA_BASE}/markets?${qs.toString()}`, {
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Gamma ${res.status}`);
    const rows = (await res.json()) as GammaRow[];
    for (const r of rows) {
      if (!r.conditionId || !r.clobTokenIds) continue;
      try {
        const ids = JSON.parse(r.clobTokenIds);
        if (Array.isArray(ids) && ids.length === 2 && ids[0] && ids[1]) {
          out.push({ conditionId: r.conditionId, question: r.question ?? "", yesTokenId: String(ids[0]), noTokenId: String(ids[1]) });
        }
      } catch {
        // skip rows with unparseable token ids — the canary only needs clean binary rows
      }
    }
    if (rows.length < 100) break;
  }
  return out;
}

async function main() {
  console.log(`1. Gamma: discover live binary markets resolving >${MIN_RESOLVE_LEAD_MS / 60_000}min out, with clobTokenIds...`);
  const pairs = await fetchTokenPairs(2);
  assert.ok(pairs.length >= 100, `need >=100 binary markets for a 200-token batch (got ${pairs.length})`);
  console.log(`   got ${pairs.length} binary markets (${pairs.length * 2} tokens)`);

  // 2. /books accepts a 200-token batch — through the SAME raw POST the flush uses. On this
  //    >15min-out universe the contract is NEAR-FULL coverage: every token here has a live book,
  //    so a coverage collapse means Polymarket started omitting LIVE books (the regression this
  //    canary exists to catch). Imminent-expiry omissions are a different, legitimate population
  //    (see header) and are excluded by the token-set filter, not by a loose floor. What must also
  //    hold: every returned book belongs to the request set (asset_id matching), and sampled
  //    omissions are genuinely bookless when re-asked alone — the fact the negative cache in
  //    clob.ts is built on.
  console.log("2. POST /books with a 200-token batch...");
  const batch = pairs.slice(0, 100).flatMap((p) => [p.yesTokenId, p.noTokenId]);
  assert.strictEqual(batch.length, 200, "exactly 200 token ids");
  const raw = await postBooks(batch);
  assert.ok(Array.isArray(raw), "response is an array");
  const byAssetId = new Map(raw.map((b) => [b.asset_id, b]));
  for (const b of raw) {
    assert.ok(b.asset_id && batch.includes(b.asset_id), `returned asset_id ${b.asset_id} is in the request set`);
  }
  const covered = batch.filter((id) => byAssetId.has(id)).length;
  assert.ok(
    covered >= Math.ceil(batch.length * MIN_COVERAGE),
    `near-full coverage on >15min-out markets (${covered}/200 covered; contract >=${MIN_COVERAGE * 100}%) — Polymarket may be omitting LIVE books`,
  );
  const missing = batch.filter((id) => !byAssetId.has(id));
  for (const id of missing.slice(0, 5)) {
    const single = await postBooks([id]);
    assert.strictEqual(single.length, 0, `omitted token ${id.slice(0, 12)}… stays omitted when asked alone (absent = bookless)`);
  }
  console.log(`   ✓ 200-token batch accepted; ${covered}/200 covered, ${missing.length} omitted (sample re-verified bookless)`);

  // From here on, work only with pairs where BOTH tokens came back — bookless pairs prove nothing
  // about matching.
  const livePairs = pairs.slice(0, 100).filter((p) => byAssetId.has(p.yesTokenId) && byAssetId.has(p.noTokenId));
  assert.ok(livePairs.length >= 5, `need >=5 fully-live pairs for the matching checks (got ${livePairs.length})`);

  // 3. Order is NOT assumed: request a shuffled subset and assert every token still gets ITS OWN
  //    book via asset_id matching (a positional implementation fails this whenever orders differ).
  console.log("3. asset_id matching under a shuffled request...");
  const subset = livePairs.slice(0, 10).flatMap((p) => [p.yesTokenId, p.noTokenId]);
  const shuffled = [...subset].sort(() => Math.random() - 0.5);
  const books = await getBooks(shuffled);
  for (const id of subset) {
    const book = books.get(id);
    assert.ok(book, `book present for token ${id.slice(0, 12)}…`);
    assert.strictEqual(book!.tokenId, id, "each token got its OWN book (asset_id match, not position)");
  }
  console.log(`   ✓ ${subset.length} tokens resolved to their own books regardless of request order`);

  // 4. Both tokens of a binary resolve to TWO DISTINCT books.
  console.log("4. both tokens of one binary -> two distinct books...");
  const one = livePairs[0]!;
  const yes = (await getBooks([one.yesTokenId])).get(one.yesTokenId);
  const no = (await getBooks([one.noTokenId])).get(one.noTokenId);
  assert.ok(yes && no, `both books exist for "${one.question.slice(0, 50)}"`);
  assert.notStrictEqual(yes!.tokenId, no!.tokenId, "distinct asset_ids");
  assert.ok(yes!.asks.length + yes!.bids.length > 0, "YES book has levels");
  assert.ok(no!.asks.length + no!.bids.length > 0, "NO book has levels");
  console.log(`   ✓ YES(${yes!.tokenId.slice(0, 10)}…) asks=${yes!.asks.length} / NO(${no!.tokenId.slice(0, 10)}…) asks=${no!.asks.length}`);

  // 5. Level + book field shape: levels parse from decimal strings; book metadata fields present.
  console.log("5. level shape + book metadata (min_order_size / tick_size / neg_risk / hash)...");
  let levelsChecked = 0;
  for (const b of raw) {
    assert.ok(b.min_order_size !== undefined, "min_order_size present");
    assert.ok(b.tick_size !== undefined, "tick_size present");
    assert.ok(typeof b.neg_risk === "boolean", "neg_risk present (boolean)");
    assert.ok(typeof b.hash === "string", "hash present (string)");
    for (const side of [b.asks ?? [], b.bids ?? []]) {
      for (const l of side) {
        const p = Number(l.price);
        const s = Number(l.size);
        assert.ok(Number.isFinite(p) && p >= 0 && p <= 1, `level price parses to [0,1] (got ${l.price})`);
        assert.ok(Number.isFinite(s) && s >= 0, `level size parses to >=0 (got ${l.size})`);
        levelsChecked++;
      }
    }
  }
  assert.ok(levelsChecked > 0, "at least some levels were checked");
  console.log(`   ✓ ${levelsChecked} levels parse; metadata fields present on ${raw.length} books`);

  console.log("\nclob: VERIFIED");
}

main().catch((e) => {
  console.error("clob verify FAILED:", e);
  process.exit(1);
});
