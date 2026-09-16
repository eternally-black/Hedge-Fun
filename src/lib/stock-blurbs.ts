// One-line "what is this company/fund" copy for the tokenized-stock cards. A ticker and a name
// ("SMCIx", "Super Micro Computer xStock") tell a user nothing; ten plain words do.
//
// Written ONCE per asset and stored: the answer does not change between ticks, so this is a cache
// fill, not a per-request LLM call (the serve paths never touch this module). fillMissingBlurbs only
// ever writes rows whose blurb is null, which makes a hand-written blurb permanent.
//
// Same transport as the NLU edge (src/lib/hedge/nlu.ts): raw fetch against the OpenAI-compatible
// /chat/completions shape, one call per batch, no retries, no SDK. No NLU_API_KEY -> we do nothing
// at all. A batch that fails or comes back unparseable is SKIPPED (those assets stay null and the
// next catalog tick retries them) — blurbs are decoration and must never break a poller tick.

import type { PrismaClient } from "@prisma/client";
import { extractText, deepseekThinkingOff } from "./hedge/nlu";
import { deadlineLeftMs, boundedTimeoutMs } from "./deadline";

const BLURB_TIMEOUT_MS = 30_000; // a 20-item batch generates ~200 tokens; well past the NLU edge's 5s
const BLURB_MIN_LEFT_MS = 5_000; // less budget than this left -> do not start another batch
const API_BASE = process.env.NLU_API_BASE || "https://openrouter.ai/api/v1";
const MODEL = process.env.NLU_MODEL || "deepseek/deepseek-v4";

// Validation bounds. 12 words / 90 chars is "10 words plus slack" — a model that ran long still
// passes, one that wrote a sentence does not.
const MAX_WORDS = 12;
const MAX_CHARS = 90;

export interface BlurbItem {
  symbol: string;
  name: string;
  underlying: string;
  isin?: string | null;
}

const SYSTEM_PROMPT =
  "You write one-line descriptions of listed companies and funds for a trading app. For each " +
  "tokenized stock, write what the underlying company or fund does in at most 10 plain English " +
  "words. No hype, no tickers, no 'xStock', no trailing period. If unsure, describe the sector " +
  "only. Output only the JSON object.";

// Catalog text is UNTRUSTED: it comes from the xStocks feed, and a name nobody bounded would become
// a prompt nobody bounded (a megabyte of "name" is a megabyte of tokens, and control characters can
// forge lines of their own). Clamp every field to what a real one needs and flatten it to one line.
const clamp = (v: string | null | undefined, max: number): string =>
  (v ?? "")
    .replace(/\p{C}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

// One system+user prompt for the whole batch. STRICT JSON keyed by the symbol we asked for, so a
// reordered or partial answer still maps back to the right asset.
export function blurbPrompt(items: BlurbItem[]): string {
  const lines = items.map((i) => {
    const isin = clamp(i.isin, 16) ? `, ISIN ${clamp(i.isin, 16)}` : "";
    return `- ${clamp(i.symbol, 16)}: ${clamp(i.name, 80)} (underlying ticker ${clamp(i.underlying, 12)}${isin})`;
  });
  return (
    `${SYSTEM_PROMPT}\n\n` +
    `Return one minified JSON object mapping each symbol below to its description, exactly ` +
    `{"<symbol>": "<blurb>"}. Stocks:\n${lines.join("\n")}\n`
  );
}

// Tolerant extraction + validation. PURE (unit-tested in scripts/test-stocks.ts): the LLM is the
// untrusted input here, so every blurb that reaches the DB passed through this function.
export function parseBlurbs(raw: string, symbols: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return out;
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return out;
  }
  if (typeof obj !== "object" || obj === null) return out;
  const o = obj as Record<string, unknown>;
  for (const symbol of symbols) {
    const v = o[symbol];
    if (typeof v !== "string") continue;
    // A newline means the model wrote more than a line — reject before collapsing it away.
    if (/[\r\n]/.test(v)) continue;
    const blurb = normaliseBlurb(v);
    if (!blurb) continue;
    if (blurb.length > MAX_CHARS) continue;
    if (blurb.split(" ").length > MAX_WORDS) continue;
    // "AAPLx" -> "AAPL xStock" -> "AAPL" is the ticker echoed back, not a description. (The NAME
    // echoed back is caught in fillMissingBlurbs, which is the only place that knows the name.)
    if (isEcho(blurb, symbol) || isEcho(blurb, symbol.replace(/x$/, ""))) continue;
    out[symbol] = blurb;
  }
  return out;
}

// Strip the model's usual garnish: quotes, "xStock", a trailing period, ragged whitespace.
function normaliseBlurb(v: string): string {
  return v
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\bxstocks?\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/, "")
    .trim();
}

// "Apple xStock" answered with "Apple" is a non-answer — the card already shows the name.
function isEcho(blurb: string, other: string): boolean {
  const norm = (s: string) => normaliseBlurb(s).toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  const b = norm(blurb);
  return b.length > 0 && b === norm(other);
}

export interface FillResult {
  scanned: number;
  written: number;
  skipped: number;
}

// Fill up to `max` missing blurbs, deck-eligible assets first (they are what a user actually sees).
// Returns zeros without calling anything when no key is configured — the common case in dev/tests.
export async function fillMissingBlurbs(
  prisma: PrismaClient,
  opts?: { max?: number; batch?: number },
): Promise<FillResult> {
  const key = process.env.NLU_API_KEY;
  if (!key) return { scanned: 0, written: 0, skipped: 0 };
  const max = opts?.max ?? 40;
  const batchSize = opts?.batch ?? 20;

  const rows = await prisma.stockAsset.findMany({
    where: { blurb: null },
    orderBy: [{ deckEligible: "desc" }, { liquidityCents: { sort: "desc", nulls: "last" } }],
    take: max,
    select: { id: true, symbol: true, name: true, underlying: true, isin: true },
  });
  let written = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    // Batches run one after another, each with its own 30 s timeout — two slow ones outlive the
    // poller tick that asked for them. Stop while there is still time for the caller to finish.
    const left = deadlineLeftMs();
    if (left !== undefined && left < BLURB_MIN_LEFT_MS) break;
    const batch = rows.slice(i, i + batchSize);
    const blurbs = await generateBlurbs(batch, key);
    for (const r of batch) {
      const blurb = blurbs[r.symbol];
      if (!blurb || isEcho(blurb, r.name) || isEcho(blurb, r.underlying)) continue;
      // Guarded by blurb:null so a hand-written one is never clobbered by a later tick.
      const res = await prisma.stockAsset.updateMany({ where: { id: r.id, blurb: null }, data: { blurb } });
      written += res.count;
    }
  }
  return { scanned: rows.length, written, skipped: rows.length - written };
}

// One LLM call for one batch. Every failure mode (non-2xx, timeout, unparseable body) resolves to an
// empty map — the caller then writes nothing for this batch and the next tick retries it.
async function generateBlurbs(items: BlurbItem[], key: string): Promise<Record<string, string>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), boundedTimeoutMs(BLURB_TIMEOUT_MS));
  try {
    const res = await fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      cache: "no-store",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        // DeepSeek's platform models (deepseek-flash, deepseek-v4-pro) are reasoning models that put
        // the whole budget into reasoning_content and answer "" with finish_reason "length" — verified
        // live 2026-09-16 at 400 AND 2048 tokens. Their API takes thinking:{type:"disabled"}, which
        // makes them answer directly (43 completion tokens, 1.2 s). Only sent to that host: OpenRouter
        // and others do not know the field.
        ...deepseekThinkingOff(API_BASE),
        // A reasoning model spends completion tokens BEFORE the answer and max_tokens caps the sum
        // (see nlu.ts): 20 blurbs are ~300 tokens of JSON, the rest is headroom for the reasoning.
        max_tokens: 2048,
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: blurbPrompt(items) },
        ],
      }),
    });
    if (!res.ok) {
      console.warn(`[stock-blurbs] http ${res.status} — skipping batch of ${items.length}`);
      return {};
    }
    const parsed = parseBlurbs(extractText(await res.json()), items.map((i) => i.symbol));
    if (Object.keys(parsed).length === 0) console.warn(`[stock-blurbs] no usable blurbs in a batch of ${items.length}`);
    return parsed;
  } catch (e) {
    console.warn(`[stock-blurbs] ${(e as Error).name} — skipping batch of ${items.length}`);
    return {};
  } finally {
    clearTimeout(timer);
  }
}
