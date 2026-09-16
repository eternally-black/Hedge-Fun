// NLU edge (D2) — the ONE thin LLM touch in the whole engine, and only below the deterministic
// confidence threshold. A single constrained small-model call maps free text -> { category, entities,
// keywords }; the caller then RE-RUNS the deterministic matcher with those entities. The LLM NEVER
// picks a side, size, or market (D1 invariant). No NLU_API_KEY, a non-2xx, a timeout, or an
// unparseable body all resolve to null -> the caller falls straight to the discovery fallback. One
// call, 5s timeout, no retries, raw fetch (no SDK dependency).
//
// PROVIDER-AGNOSTIC via the OpenAI-compatible /chat/completions shape — OpenRouter, DeepSeek, Kimi,
// MiniMax, GLM and OpenAI itself all speak it, so one request shape covers every candidate. Point
// NLU_API_BASE/NLU_API_KEY/NLU_MODEL wherever you want; nothing else in the engine knows or cares.

import { createHash } from "node:crypto";
import type { SituationPeriod } from "./situation";

export interface NluResult {
  category: string | null; // "sports" | "esports" | "entertainment" | "crypto" | a life-cost category (see stock-rules) | "other" | null
  entities: string[]; // proper nouns: teams, clubs, people, titles
  keywords: string[]; // other salient terms
  // B-P2: optional life-situation fields. OMITTED (not undefined) when the model didn't supply a
  // valid value — existing callers deepStrictEqual against the old 3-key shape.
  amountCents?: number;
  period?: SituationPeriod;
}

const NLU_TIMEOUT_MS = 5_000;
// No default base/model on purpose: an unset key already disables the edge, and guessing a provider
// would silently point at someone's billing.
const NLU_BASE = process.env.NLU_API_BASE || "https://openrouter.ai/api/v1";
const NLU_MODEL = process.env.NLU_MODEL || "deepseek/deepseek-v4";

const SYSTEM_PROMPT =
  "You are a strict NLU extractor for a hedging app. The user describes something they care about " +
  "or spend on: a sports team they support, an event, or a life cost (flights, fuel/driving, taxis, " +
  "rent, groceries, electricity, healthcare, subscriptions, online shopping, coffee/dining, their " +
  "tech job, a crypto bag). Respond with ONLY one minified JSON object, no prose, no code fences, " +
  'exactly this schema: {"category": string|null, "entities": string[], "keywords": string[], ' +
  '"amountCents": integer|null, "period": string|null}. "category" is one of "sports","esports",' +
  '"entertainment","crypto","travel","driving","rides","housing","groceries","energy","healthcare",' +
  '"tech_job","streaming","shopping","dining","market","other" or null. "entities" are proper nouns ' +
  '(teams, clubs, people, titles, brands) in canonical English. "keywords" are other salient terms. ' +
  '"amountCents" is a money amount the user states, converted to USD integer cents (assume USD when ' +
  'unclear), else null. "period" is "month","week","year" or "once" when stated, else null. The ' +
  "message may be in English, Russian or Ukrainian. Do NOT choose stocks, bets, sides, sizes or " +
  "markets — extraction only.";

function buildUserPrompt(text: string): string {
  return `User message: ${JSON.stringify(text)}\nReturn the JSON object now.`;
}

// Pull the first balanced {...} object out of the model text and validate it against the schema.
// Tolerant of stray prose / code fences around the JSON. Returns null on anything malformed — the
// caller treats null as "NLU gave us nothing" and falls back deterministically. PURE + unit-tested.
export function parseNluResponse(raw: string): NluResult | null {
  if (!raw) return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  const toStrArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()) : [];
  const category = typeof o.category === "string" && o.category.trim() ? o.category.trim().toLowerCase() : null;
  const entities = toStrArray(o.entities);
  const keywords = toStrArray(o.keywords);
  // A result with neither entities nor keywords carries no signal for a re-run.
  if (entities.length === 0 && keywords.length === 0 && category === null) return null;
  const out: NluResult = { category, entities, keywords };
  // B-P2: only attach the optional fields when the model supplied a VALID value. Invalid/absent
  // values must leave the KEY OFF entirely — existing tests deepStrictEqual against the old shape.
  if (typeof o.amountCents === "number" && Number.isFinite(o.amountCents) && o.amountCents >= 0) {
    out.amountCents = Math.round(o.amountCents);
  }
  if (o.period === "month" || o.period === "week" || o.period === "year" || o.period === "once") {
    out.period = o.period;
  }
  return out;
}

// Extract the assistant text from an OpenAI-compatible /chat/completions body.
export function extractText(data: unknown): string {
  const c = (data as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
  return typeof c === "string" ? c : "";
}

export interface NluOutcome {
  result: NluResult | null;
  usedNlu: boolean; // true once we actually attempted a call (key present) — for telemetry
  latencyMs: number;
}

// Stable, non-reversible fingerprint of the free text — lets us correlate/replay a request (D2)
// WITHOUT spilling the raw query (personal plans / PII) into container logs (F6). First 12 hex chars
// of sha256 is plenty to group identical inputs; it is NOT the raw text and can't be reversed to it.
function inputFingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

// The single NLU call. Returns { result:null, usedNlu:false } instantly when no key is configured
// (the common case, incl. the test env). Logs a hash of the input + the parsed output + latency for
// replayability (D2); the RAW input text is logged ONLY when HEDGE_NLU_LOG_RAW=1 (debug, off in prod).
export async function extractEntities(text: string): Promise<NluOutcome> {
  const key = process.env.NLU_API_KEY;
  if (!key) return { result: null, usedNlu: false, latencyMs: 0 };

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NLU_TIMEOUT_MS);
  try {
    const res = await fetch(`${NLU_BASE}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      cache: "no-store",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: NLU_MODEL,
        // Reasoning models (DeepSeek v4, and every current small model worth using here) spend
        // completion tokens on reasoning BEFORE the answer, and max_tokens caps the sum. At 256 the
        // reasoning ate the whole budget: finish_reason "length", content "" — i.e. the NLU edge
        // silently fell back on EVERY request. Measured on deepseek-v4-flash-vision-exp with this
        // exact prompt: 236-468 reasoning tokens, ~20 for the JSON itself. 1024 leaves ~2x headroom.
        max_tokens: 1024,
        temperature: 0, // extraction, not generation — same text must map to the same entities
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(text) },
        ],
      }),
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      console.warn(`[hedge/nlu] http ${res.status} (${latencyMs}ms) — falling back`);
      return { result: null, usedNlu: true, latencyMs };
    }
    const data = await res.json();
    const result = parseNluResponse(extractText(data));
    // Default: hash(input) + parsed output + latency (replayable, no raw PII). Raw text is gated
    // behind an explicit debug flag (HEDGE_NLU_LOG_RAW=1, documented in .env.example).
    if (process.env.HEDGE_NLU_LOG_RAW === "1") {
      console.log(`[hedge/nlu] in=${JSON.stringify(text)} out=${JSON.stringify(result)} latency=${latencyMs}ms`);
    } else {
      console.log(`[hedge/nlu] inHash=${inputFingerprint(text)} out=${JSON.stringify(result)} latency=${latencyMs}ms`);
    }
    return { result, usedNlu: true, latencyMs };
  } catch (e) {
    const latencyMs = Date.now() - started;
    console.warn(`[hedge/nlu] ${(e as Error).name} (${latencyMs}ms) — falling back`);
    return { result: null, usedNlu: true, latencyMs };
  } finally {
    clearTimeout(timer);
  }
}
