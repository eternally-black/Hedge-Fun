// Stock-card DB glue (B-P3/B-P4). Turns StockAsset rows + the pure stock-rules table into the SAME
// HedgeSuggestion wire type the market hedges use, with the DeckCard fields as SENTINELS (see
// api-types.ts). Three surfaces ride this module:
//   • deriveWalletStock()      — S1-stock: a wallet major / SPL aggregate → a tokenized-stock leg.
//   • searchLife()             — S3-stock: free text → life-situation rules → stock cards (+ S2).
//   • deriveLifeStockForAccept()/spottedForUser() — re-derivation WITHOUT the query text (that is
//     what LifeSituation persistence is for) and the proactive "spotted" cards.
//
// The ONE place this module touches StockAsset is loadStockAssets — every other function takes the
// loaded map, so a single read serves a whole request and the three builders can never disagree on
// which ticker was offered. buildLifeCard is the shared builder for all three life paths.

import { prisma } from "../prisma";
import { isTradable } from "../stocks";
import { effectiveRealMode } from "../real";
import { sizeByPct } from "./size";
import { stockSuggestionId } from "./id";
import {
  STOCK_RULES,
  WALLET_STOCK_RULES,
  matchStockRules,
  ruleByCategory,
  evalTriggers,
  renderCopy,
  fmtChange,
  fmtPeriod,
  fmtDistance,
  type StockRule,
} from "./stock-rules";
import { parseSituation } from "./situation";
import { searchS2, type S2SearchOutcome } from "./s2";
import type { DerivedSuggestion } from "./suggest";
import type { SnapshotData } from "./snapshot";
import type { HedgeSituation, HedgeSuggestion } from "../api-types";
import {
  HEDGE_STOCK_WALLET_PCT_BP,
  HEDGE_STOCK_FIXED_CENTS,
  HEDGE_STOCK_PRICE_MAX_AGE_MS,
  HEDGE_MIN_NOTIONAL_CENTS,
  HEDGE_SPOTTED_MAX,
} from "../config";

// One offered stock asset, already filtered for staleness/halt/price. `tradable` is the REAL-buy
// gate (isTradable) — a card may still be shown for a paper buy when false.
export interface StockAssetRow {
  id: string;
  symbol: string;
  name: string;
  blurb: string | null;
  mint: string;
  logoUrl: string | null;
  priceCents: number;
  change24hBp: number | null;
  tradable: boolean;
  decimals: number;
}

// Load the offered assets for a set of symbols. ONE query; drops halted, unpriced, and stale rows —
// and, with realOnly, every asset that cannot be bought on chain: in real mode a card is only ever
// offered for something the swipe can actually buy. The ONLY place this module reads StockAsset —
// callers pass the map around.
export async function loadStockAssets(symbols: string[], nowMs: number, realOnly = false): Promise<Map<string, StockAssetRow>> {
  const out = new Map<string, StockAssetRow>();
  if (symbols.length === 0) return out;
  const rows = await prisma.stockAsset.findMany({ where: { symbol: { in: symbols } } });
  const cutoff = nowMs - HEDGE_STOCK_PRICE_MAX_AGE_MS;
  for (const r of rows) {
    if (r.halted) continue;
    if (realOnly && !isTradable(r)) continue;
    if (r.priceCents == null || r.priceCents <= 0) continue;
    if (r.pricedAt == null || r.pricedAt.getTime() < cutoff) continue;
    out.set(r.symbol, {
      id: r.id,
      symbol: r.symbol,
      name: r.name,
      blurb: r.blurb,
      mint: r.mint,
      logoUrl: r.logoUrl,
      priceCents: r.priceCents,
      change24hBp: r.change24hBp,
      tradable: isTradable(r),
      decimals: r.decimals,
    });
  }
  return out;
}

// The app's ONE Paper/Real switch, as the hedge paths need it: true when this user's cards must be
// buyable on chain. One small read per request; the four builders below all pass it to loadStockAssets.
export async function realOnlyFor(userId: string): Promise<boolean> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { realMode: true, realConsentAt: true, realConsentVersion: true } });
  return u !== null && effectiveRealMode(u) === "REAL";
}

// First ticker in preference order that is actually offered. null when none is — the caller skips
// the rule rather than showing a card for an asset we cannot price.
export function firstOffered(tickers: string[], assets: Map<string, StockAssetRow>): StockAssetRow | null {
  for (const t of tickers) {
    const a = assets.get(t);
    if (a) return a;
  }
  return null;
}

// "$800" / "$1,234" — whole dollars, en-US grouping, no decimals. The copy slots take this string.
export function usdWhole(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

export interface BuildStockArgs {
  kind: "S1-stock" | "S3-stock" | "spotted";
  sid: string;
  stakeCents: number;
  hedgePctBp: number;
  rationale: string;
  hedgedAsset?: string;
  hedgedNotionalCents?: number;
  situation?: HedgeSituation;
  triggerChangeBp?: number;
}

// The sentinel card. Every DeckCard field is a placeholder — render off `stock`, never off the
// market fields (see api-types.ts). `id` is "stock:<SYMBOL>" so a client that keys on id still gets
// a stable, unique value.
export function buildStockSuggestion(a: StockAssetRow, p: BuildStockArgs): HedgeSuggestion {
  return {
    id: `stock:${a.symbol}`,
    question: p.rationale,
    category: "stocks",
    league: null,
    outcomeYesLabel: a.symbol,
    outcomeNoLabel: "",
    yesPriceBp: 0,
    noPriceBp: 0,
    resolutionDeadline: "",
    startsAt: null,
    suggestionId: p.sid,
    kind: p.kind,
    side: "YES",
    sideLabel: a.symbol,
    proposedStakeCents: p.stakeCents,
    hedgedAsset: p.hedgedAsset ?? "",
    hedgedNotionalCents: p.hedgedNotionalCents ?? 0,
    isProxy: false,
    avgBuyCostNarrative: null,
    stock: {
      symbol: a.symbol,
      name: a.name,
      blurb: a.blurb,
      mint: a.mint,
      logoUrl: a.logoUrl,
      priceCents: a.priceCents,
      change24hBp: a.change24hBp,
      tradable: a.tradable,
    },
    rationale: p.rationale,
    hedgePctBp: p.hedgePctBp,
    situation: p.situation,
    triggerChangeBp: p.triggerChangeBp,
  };
}

// Stake for a life-hedge: a stated amount sizes by the rule's pct; no amount → the fixed stake.
function stakeFor(amountCents: number | null, pctBp: number): number {
  return amountCents ? sizeByPct(amountCents, pctBp) || HEDGE_STOCK_FIXED_CENTS : HEDGE_STOCK_FIXED_CENTS;
}

// Every ticker a trigger or a rule can point at — the set the spotted paths must have priced.
function allRuleTickers(): string[] {
  const tickers = new Set<string>();
  for (const rule of STOCK_RULES) {
    if (rule.trigger) tickers.add(rule.trigger.symbol);
    for (const t of rule.tickers) tickers.add(t);
  }
  return [...tickers];
}

// ── S1-stock: wallet exposure → a tokenized-stock leg ─────────────────────────────────────────────

export async function deriveWalletStock(snapshot: SnapshotData, nowMs: number, realOnly = false): Promise<DerivedSuggestion[]> {
  const rules = WALLET_STOCK_RULES;
  const tickers = [...new Set(rules.flatMap((r) => r.tickers))];
  const assets = await loadStockAssets(tickers, nowMs, realOnly);

  const items: DerivedSuggestion[] = [];
  const push = (asset: string, notionalCents: number, rule: (typeof rules)[number]) => {
    if (notionalCents < HEDGE_MIN_NOTIONAL_CENTS) return;
    const stake = sizeByPct(notionalCents, HEDGE_STOCK_WALLET_PCT_BP);
    if (stake <= 0) return;
    const a = firstOffered(rule.tickers, assets);
    if (!a) return;
    const rationale = renderCopy(rule.copy, { amount: usdWhole(notionalCents), ticker: a.symbol });
    const sid = stockSuggestionId({
      kind: "S1_STOCK",
      symbol: a.symbol,
      address: snapshot.address,
      hedgedAsset: asset,
      hedgedNotionalCents: notionalCents,
    });
    items.push({
      address: snapshot.address,
      enumKind: "S1_STOCK",
      suggestion: buildStockSuggestion(a, {
        kind: "S1-stock",
        sid,
        stakeCents: stake,
        hedgePctBp: HEDGE_STOCK_WALLET_PCT_BP,
        rationale,
        hedgedAsset: asset,
        hedgedNotionalCents: notionalCents,
      }),
    });
  };

  for (const m of snapshot.exposure.majors) {
    const rule = rules.find((r) => r.asset === m.asset);
    if (!rule) continue;
    push(m.asset, m.notionalCents, rule);
  }
  const splRule = rules.find((r) => r.asset === "SPL");
  if (splRule) push("SPL", snapshot.exposure.splAggregateCents, splRule);

  return items;
}

// ── shared life-card builder (searchLife / deriveLifeStockForAccept / spottedForUser) ─────────────

interface LifeCardOpts {
  kind: "S3-stock" | "spotted";
  amountCents: number | null;
  period: string | null;
  distanceKm: number | null;
  changeBp?: number;
  triggerChangeBp?: number;
}

// Build ONE life card for a rule + asset. The three life paths all funnel through here so ids and
// copy can never disagree between search and accept re-derivation.
function buildLifeCard(rule: StockRule, asset: StockAssetRow, opts: LifeCardOpts): HedgeSuggestion {
  const amount = opts.amountCents;
  const stake = stakeFor(amount, rule.pctBp);
  const copy =
    opts.kind === "spotted"
      ? rule.copy.spotted ?? rule.copy.noAmount
      : amount
        ? rule.copy.withAmount
        : rule.copy.noAmount;
  const rationale = renderCopy(copy, {
    amount: amount ? usdWhole(amount) : undefined,
    period: fmtPeriod(opts.period),
    distance: opts.distanceKm ? fmtDistance(opts.distanceKm, opts.period) : undefined,
    change: opts.changeBp != null ? fmtChange(opts.changeBp) : undefined,
    ticker: asset.symbol,
  });
  const sid =
    opts.kind === "spotted"
      ? stockSuggestionId({ kind: "SPOTTED", symbol: asset.symbol, category: rule.category })
      : stockSuggestionId({
          kind: "S3_STOCK",
          symbol: asset.symbol,
          category: rule.category,
          amountCents: amount ?? 0,
        });
  const situation: HedgeSituation = {
    category: rule.category,
    amountCents: amount,
    period: (opts.period as HedgeSituation["period"]) ?? null,
    distanceKm: opts.distanceKm,
  };
  return buildStockSuggestion(asset, {
    kind: opts.kind,
    sid,
    stakeCents: stake,
    hedgePctBp: amount ? rule.pctBp : 0,
    rationale,
    situation,
    triggerChangeBp: opts.triggerChangeBp,
  });
}

// ── S3-stock: free-text life search ───────────────────────────────────────────────────────────────

export interface LifeSearchOutcome extends S2SearchOutcome {
  stockSuggestions: HedgeSuggestion[];
  situation: HedgeSituation | null;
}

export async function searchLife(userId: string, text: string, amountCents: number | null): Promise<LifeSearchOutcome> {
  const parsed = parseSituation(text);
  let amount = parsed.amountCents ?? amountCents ?? null;
  // The amount box on the hedge screen is labelled "$ / month": an amount that arrives through it
  // (nothing parsed from the text) is monthly by construction.
  let period: string | null = parsed.period ?? (parsed.amountCents == null && amountCents != null ? "month" : null);
  const distanceKm = parsed.distanceKm;

  let hits = matchStockRules(text, { amountCents: amount, distanceKm });
  const out = await searchS2(text, { allowNlu: hits.length === 0 });

  if (hits.length === 0 && out.nluResult?.category) {
    const rule = ruleByCategory(out.nluResult.category);
    if (rule) {
      hits = [{ rule, hits: 1, confidence: 0.6 }];
      amount ??= out.nluResult.amountCents ?? null;
      period ??= out.nluResult.period ?? null;
    }
  }

  const tickers = [...new Set(hits.flatMap((h) => h.rule.tickers))];
  const assets = await loadStockAssets(tickers, Date.now(), await realOnlyFor(userId));

  const stockSuggestions: HedgeSuggestion[] = [];
  for (let i = 0; i < hits.length; i++) {
    const rule = hits[i]!.rule;
    const asset = firstOffered(rule.tickers, assets);
    if (!asset) continue;
    // The stated amount belongs to the FIRST category only ("$800 on flights and $200 on uber" would
    // otherwise size both legs off $800); the others get the fixed stake.
    const rowAmount = i === 0 ? amount : null;
    await prisma.lifeSituation.upsert({
      where: { userId_category: { userId, category: rule.category } },
      create: { userId, category: rule.category, amountCents: rowAmount, period, distanceKm },
      update: { amountCents: rowAmount, period, distanceKm },
    });
    stockSuggestions.push(
      buildLifeCard(rule, asset, {
        kind: "S3-stock",
        amountCents: rowAmount,
        period,
        distanceKm,
      }),
    );
  }

  const situation: HedgeSituation | null = hits.length
    ? { category: hits[0]!.rule.category, amountCents: amount, period: (period as HedgeSituation["period"]) ?? null, distanceKm }
    : null;

  const result: LifeSearchOutcome = { ...out, stockSuggestions, situation };
  if (stockSuggestions.length > 0 && out.isDiscovery) {
    // A rule hit is not "nothing matched": keep the stock cards, drop the discovery filler.
    result.suggestions = [];
    result.isDiscovery = false;
    result.matchedEntity = null;
  }
  return result;
}

// ── accept re-derivation (no query text) + spotted ────────────────────────────────────────────────

export async function deriveLifeStockForAccept(userId: string, nowMs: number): Promise<DerivedSuggestion[]> {
  const rows = await prisma.lifeSituation.findMany({ where: { userId } });

  const tickers = new Set<string>(allRuleTickers());
  for (const row of rows) {
    const rule = ruleByCategory(row.category);
    if (rule) for (const t of rule.tickers) tickers.add(t);
  }
  const assets = await loadStockAssets([...tickers], nowMs, await realOnlyFor(userId));

  const items: DerivedSuggestion[] = [];

  // S3: every offered ticker of every persisted category — a card shown while ticker #1 was fine
  // must still resolve after #1 went stale and #2 took its place.
  for (const row of rows) {
    const rule = ruleByCategory(row.category);
    if (!rule) continue;
    for (const t of rule.tickers) {
      const asset = assets.get(t);
      if (!asset) continue;
      items.push({
        address: "",
        enumKind: "S3_STOCK",
        suggestion: buildLifeCard(rule, asset, {
          kind: "S3-stock",
          amountCents: row.amountCents,
          period: row.period,
          distanceKm: row.distanceKm,
        }),
      });
    }
  }

  // SPOTTED: evaluate triggers against the loaded assets' 24h changes.
  const changeBp: Record<string, number> = {};
  for (const a of assets.values()) {
    if (a.change24hBp != null) changeBp[a.symbol] = a.change24hBp;
  }
  const rowByCategory = new Map(rows.map((r) => [r.category, r]));
  for (const firing of evalTriggers(changeBp)) {
    const rule = firing.rule;
    const row = rowByCategory.get(rule.category) ?? null;
    for (const t of rule.tickers) {
      const asset = assets.get(t);
      if (!asset) continue;
      items.push({
        address: "",
        enumKind: "SPOTTED",
        suggestion: buildLifeCard(rule, asset, {
          kind: "spotted",
          amountCents: row?.amountCents ?? null,
          period: row?.period ?? null,
          distanceKm: row?.distanceKm ?? null,
          changeBp: firing.changeBp,
          triggerChangeBp: firing.changeBp,
        }),
      });
    }
  }

  return items;
}

// The proactive surface: ONE card per firing rule (firstOffered), capped, table order.
export async function spottedForUser(userId: string): Promise<HedgeSuggestion[]> {
  const nowMs = Date.now();
  const rows = await prisma.lifeSituation.findMany({ where: { userId } });
  const rowByCategory = new Map(rows.map((r) => [r.category, r]));
  const assets = await loadStockAssets(allRuleTickers(), nowMs, await realOnlyFor(userId));

  const changeBp: Record<string, number> = {};
  for (const a of assets.values()) {
    if (a.change24hBp != null) changeBp[a.symbol] = a.change24hBp;
  }

  const out: HedgeSuggestion[] = [];
  for (const firing of evalTriggers(changeBp)) {
    const rule = firing.rule;
    const asset = firstOffered(rule.tickers, assets);
    if (!asset) continue;
    const row = rowByCategory.get(rule.category) ?? null;
    out.push(
      buildLifeCard(rule, asset, {
        kind: "spotted",
        amountCents: row?.amountCents ?? null,
        period: row?.period ?? null,
        distanceKm: row?.distanceKm ?? null,
        changeBp: firing.changeBp,
        triggerChangeBp: firing.changeBp,
      }),
    );
    if (out.length >= HEDGE_SPOTTED_MAX) break;
  }
  return out;
}
