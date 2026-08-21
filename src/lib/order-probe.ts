// Server-side exchange readers: the reconciliation probe and the orphan-discovery pass, sharing
// one per-user client cache. Polymarket geoblocks our host's IP for POSTING, but not for READING —
// which is exactly why the order is posted by the browser while every number that reaches the
// ledger is read back from here. This file is the ONLY place the SDK meets those two callbacks;
// src/lib/reconcile.ts stays SDK-free so the tests can drive it with fakes.
//
// TRADES ARE THE FALLBACK TRUTH. The order record is the nicer answer — it carries the exchange's
// own `sizeMatched`, which cross-checks the trade set — but on 2026-08-17 a FAK order that really
// did fill could not be read back at all (both /api/real/posted and the discovery sweep failed on
// it), and the position stayed invisible while the money was gone. A FAK cannot match later, so
// the trades naming it are the whole story: when the order record is unavailable, they answer.
import type { PrismaClient } from "@prisma/client";
import { fetchOrder, listAccountTrades, listOpenOrders } from "@polymarket/client/actions";
import { serverSecureClient } from "./polymarket-server";
import { captureToGlitchTip } from "./glitchtip";
import type {
  OrderDiscovery,
  OrderProbe,
  OrderVerdict,
  OrphanDiscover,
  ReconcilableAttempt,
  TradeRecord,
} from "./reconcile";
import { matchesExchangeOrder, type ExchangeOrderView, type SignedOrderWire } from "./orders";

// A terminal verdict is what KILLS an attempt, so the terminal set is explicit and everything
// unrecognized reads as still-matchable (fail-safe).
const TERMINAL_STATUS = new Set(["matched", "canceled", "cancelled", "expired"]);
// Paging is bounded so a pathological account cannot pin this request open; an exhausted budget
// reads as an incomplete set (retry next pass), never as a partial booking.
const MAX_TRADE_PAGES = 20;
// How many candidate order ids discovery is willing to fetch. Truncation is treated as "could not
// check everything", never as absence.
const MAX_CANDIDATES = 10;
// The exchange's clock is not ours, so a trade may be stamped slightly before the intent it belongs to.
const CLOCK_SKEW_MS = 120_000;

type ServerClient = Awaited<ReturnType<typeof serverSecureClient>>;

// Every read failure in here used to be swallowed into a boolean. On a path whose whole job is to
// recover money, the REASON is the only thing that tells an operator whether the exchange is
// unreachable, the credentials are wrong, or the code is — and its absence cost an evening.
function noteFailure(where: string, attemptId: string, e: unknown): void {
  const err = e as { name?: string; message?: string; status?: number };
  console.warn(
    `[order-probe] ${where} failed (attempt ${attemptId}): ${err?.name ?? "Error"}` +
      `${err?.status ? ` ${err.status}` : ""} ${err?.message ?? String(e)}`,
  );
}

// One trade row → a ledger-grade record, or null. A malformed record must never enter the money
// ledger, and an unparseable fee rate is exactly the estimate reconciliation exists to remove.
function decodeTrade(raw: unknown): (TradeRecord & { takerOrderId: string }) | null {
  const t = raw as Record<string, unknown>;
  const id = String(t.id ?? "");
  const price = Number(t.price);
  const size = Number(t.size);
  if (!id || !Number.isFinite(price) || price <= 0) return null;
  if (!Number.isFinite(size) || size <= 0) return null;
  // feeRateBps is carried for observability only — reconcile.ts deliberately IGNORES it (it is the
  // BUILDER's rate; the platform rate comes from the intent's approvedParams). Rejecting the whole
  // trade on a field nothing reads made a filled order unbookable forever when the CLOB omitted it.
  const feeRateBps = Number(t.feeRateBps);
  const stamped = t.matchedAt ?? t.updatedAt;
  const ts = stamped ? new Date(String(stamped)) : new Date();
  return {
    id,
    priceBp: Math.round(price * 10_000),
    sizeMicro: BigInt(Math.round(size * 1_000_000)),
    feeRateBp: Number.isFinite(feeRateBps) && feeRateBps >= 0 ? Math.round(feeRateBps) : 0,
    ts: Number.isNaN(ts.getTime()) ? new Date() : ts,
    takerOrderId: String(t.takerOrderId ?? ""),
  };
}

// This account's trades on one token, bounded. `complete` is the load-bearing half: a short read
// must never be mistaken for "there are no more trades", because both callers use the absence of
// a trade to conclude something terminal.
async function pageTrades(
  client: NonNullable<ServerClient>,
  attempt: ReconcilableAttempt,
): Promise<{ rows: unknown[]; complete: boolean }> {
  const rows: unknown[] = [];
  try {
    const paginator = listAccountTrades(client as never, { tokenId: attempt.tokenId });
    const first = await paginator.firstPage();
    rows.push(...first.items);
    // hasMore with no usable cursor is a SHORT read, not a complete one — there is nothing to
    // resume from. Falling through to `complete: true` breaks this function's own contract above:
    // both callers turn "no trade found" into something terminal (kill the attempt, book zero
    // fills), so a fill sitting on the unread page would be discarded with the money already spent.
    if (first.hasMore && !first.nextCursor) return { rows, complete: false };
    if (first.hasMore) {
      let pages = 1;
      let more = false;
      for await (const page of paginator.from(first.nextCursor)) {
        rows.push(...page.items);
        more = page.hasMore;
        if (++pages >= MAX_TRADE_PAGES) break;
      }
      // Hitting the cap is NOT a transient miss that the next pass fixes: there is no resume
      // cursor, so every pass re-reads these same pages and comes up short again — forever,
      // silently. Rare (one order's fills spanning MAX_TRADE_PAGES) but unrecoverable without a
      // human, so it is surfaced. A persisted cursor on the attempt is the real fix if it fires.
      if (more && pages >= MAX_TRADE_PAGES) {
        await captureToGlitchTip(new Error("reconcile trade paging exhausted"), {
          route: "real/reconcile",
          attemptId: attempt.id,
          tokenId: attempt.tokenId,
          pages: String(pages),
        });
        return { rows, complete: false };
      }
    }
    return { rows, complete: true };
  } catch (e) {
    noteFailure("listAccountTrades", attempt.id, e);
    return { rows: [], complete: false }; // unreachable trades are unknown, never "no trades"
  }
}


// Verify an order id the BROWSER reported, without trusting the browser for anything but the id.
// /api/real/posted asks this before it books a cent. Three answers, and the middle one matters:
// "unverifiable" is not "wrong" — it means the exchange could not answer YET, so the attempt keeps
// its claim and the discovery sweep finishes the job, instead of the user seeing a failure for an
// order that actually filled.
export type ReportedOrderVerdict =
  | { ok: true; order: unknown }
  | { ok: false; reason: "mismatch"; detail: string }
  | { ok: false; reason: "unverifiable" };

export async function verifyReportedOrder(
  client: NonNullable<ServerClient>,
  attempt: ReconcilableAttempt,
  orderId: string,
  depositWallet: string,
): Promise<ReportedOrderVerdict> {
  const signed = attempt.signedOrder as unknown as SignedOrderWire | null;
  if (!signed || typeof signed !== "object") return { ok: false, reason: "mismatch", detail: "no_signed_order" };
  const dir = attempt.dir === "EXIT" ? "EXIT" : "ENTRY";

  let raw: Record<string, unknown> | null = null;
  try {
    const fetched = await fetchOrder(client as never, { orderId });
    raw = fetched && typeof fetched === "object" ? (fetched as Record<string, unknown>) : null;
  } catch (e) {
    noteFailure("fetchOrder(reported)", attempt.id, e);
  }

  if (raw) {
    const view: ExchangeOrderView = {
      id: String(raw.id ?? ""),
      tokenId: String(raw.tokenId ?? ""),
      makerAddress: String(raw.makerAddress ?? ""),
      side: String(raw.side ?? ""),
      originalSize: String(raw.originalSize ?? ""),
      price: String(raw.price ?? ""),
      status: String(raw.status ?? ""),
      sizeMatched: String(raw.sizeMatched ?? ""),
      createdAt: String(raw.createdAt ?? ""),
    };
    const mismatch = matchesExchangeOrder(view, {
      signed,
      dir,
      depositWallet: depositWallet.toLowerCase(),
      notBefore: attempt.createdAt,
    });
    return mismatch ? { ok: false, reason: "mismatch", detail: mismatch } : { ok: true, order: raw };
  }

  // The order record was unreadable. The trades are the fallback truth, and for a reported id they
  // are a tight one: a trade that names this id as its TAKER order, on the token this attempt
  // signed for, after the intent existed, in an account only these credentials can read. A client
  // cannot fabricate that — it would have to make the exchange print someone else's trade.
  const { rows, complete } = await pageTrades(client, attempt);
  const floorMs = attempt.createdAt.getTime() - CLOCK_SKEW_MS;
  const named = rows.some((row) => {
    const t = row as Record<string, unknown>;
    if (String(t.takerOrderId ?? "") !== orderId) return false;
    if (String(t.traderSide ?? "") !== "TAKER") return false;
    const stamped = t.matchedAt ?? t.updatedAt;
    const ts = stamped ? new Date(String(stamped)).getTime() : Number.NaN;
    return Number.isFinite(ts) && ts >= floorMs;
  });
  if (named) {
    console.warn(`[order-probe] ${attempt.id}: reported order ${orderId} verified from trade evidence`);
    return { ok: true, order: { id: orderId, source: "trade-evidence" } };
  }
  // Nothing yet, or the trade read failed. Either way this is "ask again later", never a refusal:
  // the trade records lag a match by a beat, and /api/real/posted runs milliseconds after it.
  if (!complete) noteFailure("verifyReportedOrder", attempt.id, new Error("trade read incomplete"));
  return { ok: false, reason: "unverifiable" };
}

export function realProbes(prisma: PrismaClient): { probe: OrderProbe; discover: OrphanDiscover } {
  // One client per OWNER, cached for this request — each attempt is probed with its own user's
  // credentials (the CLOB only reports an account its creds own). The deposit wallet rides along
  // because discovery needs it to tell this user's order apart from their other ones.
  const clients = new Map<string, { client: ServerClient; depositWallet: string | null }>();

  async function clientFor(userId: string): Promise<{ client: ServerClient; depositWallet: string | null }> {
    const cached = clients.get(userId);
    if (cached) return cached;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    const entry = {
      client: user ? await serverSecureClient(prisma, user) : null,
      depositWallet: user?.depositWalletAddress?.toLowerCase() ?? null,
    };
    clients.set(userId, entry);
    return entry;
  }

  const probe: OrderProbe = async (attempt: ReconcilableAttempt): Promise<OrderVerdict | null> => {
    const { client } = await clientFor(attempt.userId);
    if (!client || !attempt.externalOrderId) return null; // not configured / nothing to ask about
    const orderId = attempt.externalOrderId;

    // 0.6.0: fetchOrder is NOT curried (unlike postOrder). A failure here is no longer fatal to the
    // pass — it costs the sizeMatched cross-check, and the trades below carry the rest.
    let order: Record<string, unknown> | null = null;
    try {
      const raw = await fetchOrder(client as never, { orderId });
      order = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    } catch (e) {
      noteFailure("fetchOrder", attempt.id, e);
    }

    const { rows, complete } = await pageTrades(client, attempt);
    const associated = order && Array.isArray(order.associateTrades) ? (order.associateTrades as unknown[]).map(String) : [];
    // This order's trades: the taker order id is ours, or the order record named the trade.
    // De-duplicated by trade id FIRST — a trade reachable both ways would otherwise inflate the
    // booked size above what actually matched, which is value invented on a money ledger.
    const mine = [
      ...new Map(
        rows
          .map(decodeTrade)
          .filter((t): t is TradeRecord & { takerOrderId: string } => t !== null)
          .filter((t) => t.takerOrderId === orderId || associated.includes(t.id))
          .map((t) => [t.id, t] as const),
      ).values(),
    ];
    const collectedMicro = mine.reduce((sum, t) => sum + t.sizeMicro, 0n);

    const sizeMatched = order ? Number(order.sizeMatched) : Number.NaN;
    if (order && Number.isFinite(sizeMatched) && sizeMatched >= 0) {
      const matchedSharesMicro = BigInt(Math.round(sizeMatched * 1_000_000));
      const terminal = TERMINAL_STATUS.has(String(order.status ?? "").toLowerCase());
      if (matchedSharesMicro === 0n) return { terminal, matchedSharesMicro, trades: [] };
      // The collected set must account for EXACTLY what the exchange says matched. Short means a
      // paging cut or a dropped record and would book an attempt terminal with money missing; long
      // means a duplicate and would book value that never existed. Either way write nothing.
      if (!complete || collectedMicro !== matchedSharesMicro) return null;
      return { terminal, matchedSharesMicro, trades: mine };
    }

    // No readable order record — the case that stranded a real position on 2026-08-17. A FAK order
    // cannot match later, so a COMPLETE read of the trades naming it is the whole fill. An empty
    // one stays "unknown" rather than "killed": without the order record there is no way to tell a
    // killed order from an unreadable one, and killing a filled attempt is the one mistake here
    // that cannot be undone.
    if (!complete || mine.length === 0) return null;
    console.warn(`[order-probe] ${attempt.id}: order record unreadable, settled from ${mine.length} trade(s)`);
    return { terminal: true, matchedSharesMicro: collectedMicro, trades: mine };
  };

  // Find the exchange order an attempt never managed to report. Reads only — the caller decides
  // what to do with the answer, and the only definitive answer this may give ({ orderId: null })
  // is the one that kills an attempt, so it is fenced by the `incomplete` flag below.
  const discover: OrphanDiscover = async (attempt: ReconcilableAttempt): Promise<OrderDiscovery> => {
    try {
      // An order we cannot describe we cannot identify — and must therefore neither adopt nor
      // declare absent. The submit route persists the signed payload in the same statement as the
      // CAS claim, so a SUBMITTING row without one never reached the posting step at all.
      const signed = attempt.signedOrder as unknown as SignedOrderWire | null;
      if (!signed || typeof signed !== "object") return null;

      const { client, depositWallet } = await clientFor(attempt.userId);
      // No client, or no wallet to compare the maker against: the exchange is effectively
      // unreadable for this attempt, which is "unknown", never "absent".
      if (!client || !depositWallet) return null;

      const dir = attempt.dir === "EXIT" ? "EXIT" : "ENTRY";
      const notBefore = attempt.createdAt;
      const floorMs = notBefore.getTime() - CLOCK_SKEW_MS;
      const matches = (raw: Record<string, unknown>): boolean => {
        const id = String(raw.id ?? "");
        const tokenId = String(raw.tokenId ?? "");
        if (!id || !tokenId) return false; // a record we cannot even name is not a match
        const view: ExchangeOrderView = {
          id,
          tokenId,
          makerAddress: String(raw.makerAddress ?? ""),
          side: String(raw.side ?? ""),
          originalSize: String(raw.originalSize ?? ""),
          price: String(raw.price ?? ""),
          status: String(raw.status ?? ""),
          sizeMatched: String(raw.sizeMatched ?? ""),
          createdAt: String(raw.createdAt ?? ""),
        };
        return matchesExchangeOrder(view, { signed, dir, depositWallet, notBefore }) === null;
      };

      // `{ orderId: null }` is a licence to KILL the attempt and free its market slot, so it may
      // only be returned when every read SUCCEEDED and every candidate was checked. Any failed
      // read, truncated page or unchecked candidate makes the exchange's silence ambiguous, and an
      // ambiguous silence must read as "unknown" — a stalled orphan is recoverable, a wrongly
      // killed one is a position nobody is tracking.
      let incomplete = false;

      // Step 1 — resting orders. Ours are FAK and should never rest, but this is the cheap exact
      // case and it costs one page in the common (empty) situation.
      try {
        const paginator = listOpenOrders(client as never, { tokenId: attempt.tokenId });
        const first = await paginator.firstPage();
        // A live order of OUR OWN wallet on this token that the identity test rejects is ambiguity,
        // never proof that our order does not exist.
        const scan = (items: unknown[]): { orderId: string; order: unknown } | null => {
          for (const raw of items) {
            const row = raw as Record<string, unknown>;
            if (matches(row)) return { orderId: String(row.id), order: row };
            if (String(row.makerAddress ?? "").toLowerCase() === depositWallet) incomplete = true;
          }
          return null;
        };
        const openHit = scan(first.items);
        if (openHit) return openHit;
        // Same short read as pageTrades: more pages exist but no cursor to reach them, so the scan
        // is not exhaustive and its silence must not read as "our order is not resting".
        if (first.hasMore && !first.nextCursor) incomplete = true;
        if (first.hasMore && first.nextCursor) {
          let pages = 1;
          for await (const page of paginator.from(first.nextCursor)) {
            const hit = scan(page.items);
            if (hit) return hit;
            if (++pages >= MAX_TRADE_PAGES) {
              if (page.hasMore) incomplete = true; // cap hit with pages left: not exhaustive
              break;
            }
          }
        }
      } catch (e) {
        noteFailure("listOpenOrders", attempt.id, e);
        incomplete = true; // a failed listing is not proof of absence
      }

      // Step 2 — an order that matched and died. A FAK order that filled leaves no open order at
      // all; what it leaves is trades, and each trade names the taker order it belongs to. That is
      // the only handle the exchange gives us on an id we never learned.
      const { rows, complete } = await pageTrades(client, attempt);
      if (!complete) incomplete = true;
      const candidates: string[] = [];
      for (const raw of rows) {
        const row = raw as Record<string, unknown>;
        if (String(row.traderSide ?? "") !== "TAKER") continue; // our FAK order is always the taker
        const takerOrderId = String(row.takerOrderId ?? "");
        if (!takerOrderId) continue;
        const stamped = row.matchedAt ?? row.updatedAt;
        const ts = stamped ? new Date(String(stamped)).getTime() : Number.NaN;
        // Without a readable timestamp this cannot be told apart from one of the user's older
        // trades on the same token, so it is not a candidate.
        if (!Number.isFinite(ts) || ts < floorMs) continue;
        if (!candidates.includes(takerOrderId)) candidates.push(takerOrderId);
      }
      if (candidates.length > MAX_CANDIDATES) incomplete = true; // an unchecked candidate may be ours

      for (const orderId of candidates.slice(0, MAX_CANDIDATES)) {
        let raw: Record<string, unknown> | null = null;
        try {
          const fetched = await fetchOrder(client as never, { orderId });
          raw = fetched && typeof fetched === "object" ? (fetched as Record<string, unknown>) : null;
        } catch (e) {
          noteFailure("fetchOrder(candidate)", attempt.id, e);
        }
        if (raw) {
          if (matches(raw)) return { orderId, order: raw };
          // A taker order of THIS wallet on THIS token inside the window that the identity test
          // still rejects is ambiguity, not absence — our test may be stricter than the exchange's
          // own formatting, and declaring absence would kill an attempt whose money is spent.
          if (String(raw.makerAddress ?? "").toLowerCase() === depositWallet) incomplete = true;
          continue;
        }
        // The order record is unreadable — the failure that stranded a live position. The trade
        // itself is still evidence, and a strong one: it is OUR account's trade (the CLOB only
        // reports trades its credentials own), on the token this attempt signed for, as the TAKER,
        // after the intent existed. That is the same binding the order record would have given,
        // minus the size — which is unknowable from one trade of a possibly-partial fill anyway.
        console.warn(`[order-probe] ${attempt.id}: adopting ${orderId} on trade evidence alone`);
        return { orderId, order: { id: orderId, source: "trade-evidence" } };
      }

      // Every read landed and nothing of ours is unaccounted for: the exchange genuinely has no
      // order here, so nothing was posted and no money moved.
      return incomplete ? null : { orderId: null };
    } catch (e) {
      noteFailure("discover", attempt.id, e);
      return null; // indeterminate exchange state — no state change is safe
    }
  };

  return { probe, discover };
}
