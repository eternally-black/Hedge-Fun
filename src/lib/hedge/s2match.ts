// S2 free-text matcher — PURE core (D1/D2: deterministic FIRST, LLM only as a below-threshold edge).
// Turns a user's free text ("иду на матч Барсы", "я болею за Реал") into ranked matches against the
// indexed candidate set (team names, league labels, market questions), with a 0..1 confidence score.
// The pipeline is: normalize -> alias-expand (a small curated nickname/translit table) -> per-candidate
// scoring (exact -> substring/containment -> token coverage -> trigram Dice). No DB, no network — unit
// tested in scripts/test-hedge-cores.ts. The DB glue (src/lib/hedge/s2.ts) turns the top ENTITY match
// into an AGAINST suggestion (you support a team -> we bet the opposite side of its nearest market).

import type { BetSide } from "../api-types";

export type S2CandidateKind = "entity" | "league" | "question";
export type S2Method = "exact" | "alias" | "substring" | "token" | "trigram";

// A thing the query can match. `ref` is opaque to the matcher — the DB layer encodes marketId+side
// (entities), a league slug, or a question marker, and maps it back after ranking.
export interface S2Candidate {
  ref: string;
  label: string;
  kind: S2CandidateKind;
}

export interface S2Match {
  ref: string;
  label: string;
  kind: S2CandidateKind;
  score: number; // 0..1
  method: S2Method;
}

// Noise words dropped during normalization (EN + a little RU — the client's "мой клуб" case). Kept
// deliberately small: real team tokens must survive. Fandom verbs ("support"/"болею") and match
// filler ("vs"/"на") add nothing to entity matching.
const STOPWORDS = new Set([
  "the", "a", "an", "of", "and", "fc", "cf", "club", "team", "to", "win", "wins", "vs", "v", "at",
  "on", "for", "my", "i", "im", "support", "supporting", "go", "going", "match", "game", "against",
  "я", "за", "мой", "моя", "мою", "клуб", "команда", "команду", "на", "болею", "иду", "матч", "против",
]);

// Lowercase, strip diacritics (café -> cafe; Cyrillic й -> и harmlessly), split on non-alphanumerics
// (Unicode-aware, so Cyrillic/accented letters survive), drop stopwords + empties. Returns tokens.
export function normalize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

// Curated nickname / translit aliases -> canonical name. Keys are ALREADY normalized (lowercase, no
// punctuation). This is the one vocabulary problem deterministic code can't close on its own (D2);
// it is intentionally a small, extensible constant, not a data source. Extend freely.
export const TEAM_ALIASES: Record<string, string> = {
  // Football / soccer nicknames + RU translit
  barca: "barcelona",
  barsa: "barcelona",
  барса: "barcelona",
  барселона: "barcelona",
  реал: "real madrid",
  "реал мадрид": "real madrid",
  psg: "paris saint germain",
  псж: "paris saint germain",
  bayern: "bayern munich",
  бавария: "bayern munich",
  juve: "juventus",
  ювентус: "juventus",
  "man u": "manchester united",
  "man utd": "manchester united",
  "ман юнайтед": "manchester united",
  "манчестер юнайтед": "manchester united",
  "man city": "manchester city",
  "ман сити": "manchester city",
  spurs: "tottenham",
  gunners: "arsenal",
  ливерпуль: "liverpool",
  челси: "chelsea",
  // US sports common short forms
  niners: "san francisco 49ers",
  lakers: "los angeles lakers",
  warriors: "golden state warriors",
  // Esports
  navi: "natus vincere",
  фнатик: "fnatic",
};

// ── scoring internals ────────────────────────────────────────────────────────────────────────────

function trigramSet(s: string): Set<string> {
  const g = ` ${s} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= g.length; i++) out.add(g.slice(i, i + 3));
  return out;
}

// Sørensen–Dice coefficient over character trigrams (0..1). Order-insensitive fuzzy similarity.
function diceTrigram(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const A = trigramSet(a);
  const B = trigramSet(b);
  if (A.size === 0 || B.size === 0) return 0;
  let common = 0;
  for (const t of A) if (B.has(t)) common++;
  return (2 * common) / (A.size + B.size);
}

// Per-query-token best match against the label's tokens, averaged over query tokens: an exact token
// hit scores 1, a length>=3 substring either way scores 0.75, else the trigram similarity (damped).
function tokenCoverage(queryTokens: string[], labelTokens: string[]): number {
  if (queryTokens.length === 0 || labelTokens.length === 0) return 0;
  let sum = 0;
  for (const qt of queryTokens) {
    let best = 0;
    for (const lt of labelTokens) {
      if (qt === lt) { best = 1; break; }
      if ((qt.length >= 3 && lt.includes(qt)) || (lt.length >= 3 && qt.includes(lt))) {
        best = Math.max(best, 0.75);
      } else {
        best = Math.max(best, diceTrigram(qt, lt) * 0.9);
      }
    }
    sum += best;
  }
  return sum / queryTokens.length;
}

function scoreOne(qStr: string, qTokens: string[], lStr: string, lTokens: string[]): { score: number; method: S2Method } {
  if (qStr === lStr) return { score: 1, method: "exact" };
  // Whole-phrase containment (word-boundary padded so "real" ⊄ "montreal").
  if (` ${lStr} `.includes(` ${qStr} `) || ` ${qStr} `.includes(` ${lStr} `)) {
    return { score: 0.85, method: "substring" };
  }
  const tok = tokenCoverage(qTokens, lTokens);
  const tri = diceTrigram(qStr, lStr);
  return tok >= tri ? { score: tok, method: "token" } : { score: tri, method: "trigram" };
}

// Expand the normalized query into itself plus any curated-alias canonical forms whose key appears in
// the query as a whole token / phrase (word-boundary padded). Alias-derived matches are marked so the
// caller can cap their confidence (the alias is an inference, not what the user literally typed).
function expandQueries(qStr: string, qTokens: string[]): { str: string; tokens: string[]; isAlias: boolean }[] {
  const out = [{ str: qStr, tokens: qTokens, isAlias: false }];
  const seen = new Set([qStr]);
  const padded = ` ${qStr} `;
  for (const [key, val] of Object.entries(TEAM_ALIASES)) {
    if (qStr === key || qTokens.includes(key) || padded.includes(` ${key} `)) {
      const tokens = normalize(val);
      const str = tokens.join(" ");
      if (str && !seen.has(str)) {
        seen.add(str);
        out.push({ str, tokens, isAlias: true });
      }
    }
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Rank every candidate against the free text. Deterministic: same query + candidates -> same order
// (score desc, then ref asc as a stable tiebreak). Candidates that score 0 are dropped. The caller
// applies S2_CONFIDENCE_THRESHOLD and decides which matches become suggestions.
export function scoreMatch(query: string, candidates: S2Candidate[]): S2Match[] {
  const qTokens = normalize(query);
  const qStr = qTokens.join(" ");
  if (!qStr) return [];
  const queries = expandQueries(qStr, qTokens);

  const matches: S2Match[] = [];
  for (const c of candidates) {
    const lTokens = normalize(c.label);
    const lStr = lTokens.join(" ");
    if (!lStr) continue;

    let best: { score: number; method: S2Method } = { score: 0, method: "trigram" };
    for (const q of queries) {
      const r = scoreOne(q.str, q.tokens, lStr, lTokens);
      let score = r.score;
      let method = r.method;
      if (q.isAlias) {
        score = Math.min(score, 0.95); // alias inference never scores a literal "exact"
        if (score >= 0.85) method = "alias";
      }
      if (score > best.score) best = { score, method };
    }
    if (best.score > 0) {
      matches.push({ ref: c.ref, label: c.label, kind: c.kind, score: round2(best.score), method: best.method });
    }
  }

  matches.sort((a, b) => b.score - a.score || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  return matches;
}

// ── suggestion semantics (pure) ────────────────────────────────────────────────────────────────────

// You SUPPORT a team -> the hedge is a bet AGAINST it: the opposite outcome of the market it plays in.
export function opposingSide(side: BetSide): BetSide {
  return side === "YES" ? "NO" : "YES";
}

// The matcher has no POLARITY (F19): "Barcelona will not win" and "Barcelona will win" both contain the
// label and both score 0.85 substring, so running the winner straight through opposingSide() handed the
// NEGATIVE query the SAME position as the positive one — DOUBLING the user's real-world risk instead of
// hedging it. Polarity is read from the RAW text, never from normalize(): normalize deliberately drops
// "win"/"vs"/"против" as noise, and those are exactly the words polarity needs.
// A negation alone does NOT flip: "I'm not going to the Barcelona game" / "не могу пойти на матч Барсы"
// negate the PLAN, not the result, and a false flip is as expensive as the bug. So a flip needs an
// OUTCOME word present, and then negation XOR loss decides it ("not lose" is back to positive).
// "against"/"против" are excluded on purpose — they name a fixture ("Barcelona against Real"), not a polarity.
// Contractions arrive here with the apostrophe already stripped, so the set must hold "cant", not
// "can't". Missing an auxiliary is worse than missing a whole rule, because negation is XOR'd with
// LOSSES below: "Barcelona cant lose" then reads as an unnegated loss claim and flips the side, so
// the user gets a hedge on the outcome they were already exposed to. parse.ts's own negation regex
// already listed `cannot` — these two were the same fix and had drifted apart.
const NEGATIONS = new Set([
  "not", "never", "cant", "cannot", "wont", "isnt", "arent", "wasnt", "werent",
  "dont", "doesnt", "didnt", "couldnt", "shouldnt", "wouldnt", "hasnt", "havent", "hadnt", "aint",
  "не", "нет", "нельзя",
]);
const LOSSES = new Set(["lose", "loses", "losing", "lost", "проиграет", "проиграют", "проиграл"]);
const OUTCOMES = new Set([
  "win", "wins", "winning", "won", "beat", "beats",
  "выиграет", "выиграют", "выиграл", "победит", "победят",
  ...LOSSES,
]);

// Verbs of ALLEGIANCE, kept apart from OUTCOMES on purpose. "I don't support Barcelona" carries no
// result claim, so the outcome gate below drops it — yet it is a plain statement that the user backs
// the OTHER side, and the suggestion built from it lands on the side they already hold. Only the
// NEGATED form counts: an unnegated "I support Barcelona" is already handled by the entity match,
// and bare "against" is deliberately absent — "Barcelona against Madrid" is a fixture, not a stance,
// and flipping on it would invert every ordinary match-up query.
const STANCES = new Set(["support", "supporting", "back", "backing", "root", "rooting", "болею", "болеть", "фанат"]);

function isNegatedQuery(text: string): boolean {
  // Apostrophes stripped locally (never in normalize(), which feeds the entity regexes) so "won't"
  // reads as the negation "wont" and not as the token "won".
  const words = text.toLowerCase().replace(/['’]/g, "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const negated = words.some((w) => NEGATIONS.has(w));
  if (!words.some((w) => OUTCOMES.has(w))) {
    // No result claim. A negated allegiance is still a polarity statement; anything else ("I'm not
    // going to the Barcelona game") negates the PLAN, not the result, and must not flip.
    return negated && words.some((w) => STANCES.has(w));
  }
  return negated !== words.some((w) => LOSSES.has(w));
}

// Which side the free text actually BACKS, given the side its matched entity sits on. The hedge is the
// opposing side of THIS (buildS2Suggestion in s2.ts), so a negated query lands ON the named entity
// instead of against it: "Barcelona will not win" means the user is exposed to Barcelona LOSING.
export function backedSideForQuery(query: string, entitySide: BetSide): BetSide {
  return isNegatedQuery(query) ? opposingSide(entitySide) : entitySide;
}

// The AGAINST hedge only makes sense for a NAMED entity-vs-entity market. Over/Under totals, Up/Down,
// and bare Yes/No have no "opponent" outcome to bet, so the caller SKIPS them (spec §2 shape guard).
export function isNamedEntityShape(yesLabel: string, noLabel: string): boolean {
  const y = yesLabel.trim().toLowerCase();
  const n = noLabel.trim().toLowerCase();
  if (!y || !n) return false;
  if (y === "up" && n === "down") return false;
  if (y === "yes" && n === "no") return false;
  if (y === "over" || n === "over" || y === "under" || n === "under") return false;
  return true;
}
