// NLU edge (D2) — the ONE thin LLM touch in the whole engine, and only below the deterministic
// confidence threshold. A single constrained small-model call maps free text -> { category, entities,
// keywords }; the caller then RE-RUNS the deterministic matcher with those entities. The LLM NEVER
// picks a side, size, or market (D1 invariant). No ANTHROPIC_API_KEY, a non-2xx, a timeout, or an
// unparseable body all resolve to null -> the caller falls straight to the discovery fallback. One
// call, 5s timeout, no retries, raw fetch against api.anthropic.com (no SDK dependency).

import { createHash } from "node:crypto";

export interface NluResult {
  category: string | null; // "sports" | "esports" | "entertainment" | "crypto" | "other" | null
  entities: string[]; // proper nouns: teams, clubs, people, titles
  keywords: string[]; // other salient terms
}

const NLU_MODEL = "claude-haiku-4-5-20251001";
const NLU_TIMEOUT_MS = 5_000;
const ANTHROPIC_BASE = process.env.ANTHROPIC_API_BASE ?? "https://api.anthropic.com";

const SYSTEM_PROMPT =
  "You are a strict NLU extractor for a prediction-market hedge app. Given a short user message " +
  "about something they care about (a sports team they support, a movie they will see, an event), " +
  "extract structured fields. Respond with ONLY a single minified JSON object, no prose, no code " +
  'fences, exactly this schema: {"category": string|null, "entities": string[], "keywords": string[]}. ' +
  '"category" is one of "sports","esports","entertainment","crypto","other" or null. "entities" are ' +
  "proper nouns (teams, clubs, people, titles) in their canonical English form when obvious. " +
  '"keywords" are other salient terms. Do NOT choose bets, sides, odds, or markets — extraction only.';

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
  return { category, entities, keywords };
}

// Extract the concatenated text from an Anthropic Messages API response body.
function extractText(data: unknown): string {
  const content = (data as { content?: unknown })?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; text: string } => typeof (b as { text?: unknown })?.text === "string")
    .map((b) => b.text)
    .join("");
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
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { result: null, usedNlu: false, latencyMs: 0 };

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NLU_TIMEOUT_MS);
  try {
    const res = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
      method: "POST",
      signal: controller.signal,
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: NLU_MODEL,
        max_tokens: 256,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserPrompt(text) }],
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
