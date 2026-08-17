// Server-side exchange readers: the reconciliation probe and the orphan-discovery pass, sharing
// one per-user client cache. Polymarket geoblocks our host's IP for POSTING, but not for READING —
// which is exactly why the order is posted by the browser while every number that reaches the
// ledger is read back from here. This file is the ONLY place the SDK meets those two callbacks;
// src/lib/reconcile.ts stays SDK-free so the tests can drive it with fakes.
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
// Paging is bounded so a pathological account cannot pin this request open; the short-set guard
// below turns an exhausted budget into "unknown" (retry next pass), never into a partial booking.
const MAX_TRADE_PAGES = 20;
// How many candidate order ids discovery is willing to fetch. Truncation is treated as "could not
// check everything", never as absence.
const MAX_CANDIDATES = 10;

type ServerClient = Awaited<ReturnType<typeof serverSecureClient>>;

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

    try {
      // 0.6.0: fetchOrder is NOT curried (unlike postOrder).
      const order = (await fetchOrder(client as never, { orderId: attempt.externalOrderId })) as Record<
        string,
        unknown
      > | null;
      if (!order || typeof order !== "object") return null;

      const sizeMatched = Number(order.sizeMatched);
      if (!Number.isFinite(sizeMatched) || sizeMatched < 0) return null;
      const matchedSharesMicro = BigInt(Math.round(sizeMatched * 1_000_000));
      const terminal = TERMINAL_STATUS.has(String(order.status ?? "").toLowerCase());

      const trades: TradeRecord[] = [];
      if (matchedSharesMicro > 0n) {
        // Two bugs lived on the line this replaces. It read `.data` off the page, but the SDK's
        // Page<T> carries `items` — so `rows` was ALWAYS empty, collectedMicro was always 0, the
        // short-set guard below always fired, and no POSTED attempt was ever reconciled or had its
        // estimated fee trued up. And it took only firstPage(), so an order whose fills span pages
        // could never satisfy that guard even once the field name was right: every pass would re-read
        // the same page and return unknown again. Nothing caught it — scripts/test-reconcile.ts
        // injects its own probe and never exercises this decoding.
        const rows: unknown[] = [];
        try {
          const paginator = listAccountTrades(client as never, { tokenId: attempt.tokenId });
          const first = await paginator.firstPage();
          rows.push(...first.items);
          if (first.hasMore && first.nextCursor) {
            let pages = 1;
            let more = false;
            for await (const page of paginator.from(first.nextCursor)) {
              rows.push(...page.items);
              more = page.hasMore;
              if (++pages >= MAX_TRADE_PAGES) break;
            }
            // Hitting the cap is NOT a transient miss that the next pass fixes: there is no resume
            // cursor, so every pass re-reads these same pages, comes up short of matchedShares, and
            // returns unknown again — forever, silently. Rare (it needs one order's fills to span
            // MAX_TRADE_PAGES) but unrecoverable without a human, so it is surfaced rather than
            // absorbed. A persisted cursor on the attempt is the real fix if this ever fires.
            if (more && pages >= MAX_TRADE_PAGES) {
              await captureToGlitchTip(new Error("reconcile trade paging exhausted"), {
                route: "real/reconcile",
                attemptId: attempt.id,
                tokenId: attempt.tokenId,
                pages: String(pages),
              });
            }
          }
        } catch {
          rows.length = 0; // unreachable trades read as "no records" → unknown, retried
        }
        const associated = Array.isArray(order.associateTrades) ? (order.associateTrades as unknown[]).map(String) : [];
        for (const raw of rows) {
          const t = raw as Record<string, unknown>;
          const id = String(t.id ?? "");
          // Only this order's trades: the taker order id is ours, or the order named the trade.
          if (String(t.takerOrderId ?? "") !== attempt.externalOrderId && !associated.includes(id)) continue;
          const price = Number(t.price);
          const size = Number(t.size);
          const feeRateBps = Number(t.feeRateBps);
          // A malformed record must never enter the money ledger — and an unparseable fee rate is
          // exactly the estimate this pass exists to remove, so drop that trade too.
          if (!id || !Number.isFinite(price) || price <= 0) continue;
          if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(feeRateBps) || feeRateBps < 0) continue;
          const stamped = t.matchedAt ?? t.updatedAt;
          const ts = stamped ? new Date(String(stamped)) : new Date();
          trades.push({
            id,
            priceBp: Math.round(price * 10_000),
            sizeMicro: BigInt(Math.round(size * 1_000_000)),
            feeRateBp: Math.round(feeRateBps),
            ts: Number.isNaN(ts.getTime()) ? new Date() : ts,
          });
        }
        // The collected set must account for EXACTLY what the exchange says matched. Short is the
        // obvious hazard — a paging cut or a dropped malformed record would mark the attempt
        // terminal with money missing from the ledger. But long is a hazard too, and the guard used
        // to allow it: `associateTrades` and the taker-order-id filter can both name the same trade,
        // and any duplicate row inflates the booked size above what actually matched — 100 shares
        // reported, 200 booked, value invented on a money ledger. Either way write nothing and let
        // the next pass retry; a stalled reconcile is recoverable, a wrong one is not.
        // De-duplicate by trade id FIRST. A trade can be reached twice — once because its
        // takerOrderId is ours and once because the order's `associateTrades` names it — and the
        // paging loop above can also re-serve a row if the cursor overlaps. That duplication is the
        // actual mechanism behind an inflated size; collapsing it is the fix, and the equality check
        // below is then a genuine consistency assertion rather than a filter doing the real work.
        const unique = [...new Map(trades.map((t) => [t.id, t])).values()];
        const collectedMicro = unique.reduce((sum, t) => sum + t.sizeMicro, 0n);
        if (collectedMicro !== matchedSharesMicro) return null;
        trades.length = 0;
        trades.push(...unique);
      }
      return { terminal, matchedSharesMicro, trades };
    } catch {
      return null; // any probe failure is "unknown": no writes, next pass retries
    }
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
        // Same rule as the candidate loop below: a live order of OUR OWN wallet on this token that
        // the identity test rejects is ambiguity — never proof that our order does not exist.
        const scan = (rows: unknown[]): { orderId: string; order: unknown } | null => {
          for (const raw of rows) {
            const row = raw as Record<string, unknown>;
            if (matches(row)) return { orderId: String(row.id), order: row };
            if (String(row.makerAddress ?? "").toLowerCase() === depositWallet) incomplete = true;
          }
          return null;
        };
        const openHit = scan(first.items);
        if (openHit) return openHit;
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
      } catch {
        incomplete = true; // a failed listing is not proof of absence
      }

      // Step 2 — an order that matched and died. A FAK order that filled leaves no open order at
      // all; what it leaves is trades, and each trade names the taker order it belongs to. That is
      // the only handle the exchange gives us on an id we never learned.
      const candidateIds: string[] = [];
      try {
        const paginator = listAccountTrades(client as never, { tokenId: attempt.tokenId });
        const first = await paginator.firstPage();
        // Same skew the identity matcher allows: the exchange's clock is not ours.
        const floorMs = notBefore.getTime() - 120_000;
        const collect = (rows: unknown[]) => {
          for (const raw of rows) {
            const row = raw as Record<string, unknown>;
            if (String(row.traderSide ?? "") !== "TAKER") continue; // our FAK order is always the taker
            const takerOrderId = String(row.takerOrderId ?? "");
            if (!takerOrderId) continue;
            const stamped = row.matchedAt ?? row.updatedAt;
            const ts = stamped ? new Date(String(stamped)).getTime() : NaN;
            // Without a readable timestamp we cannot tell this trade from one of the user's older
            // trades on the same token, so it is not a candidate. fetchOrder would re-check the
            // date anyway; skipping here just keeps the fan-out honest.
            if (!Number.isFinite(ts) || ts < floorMs) continue;
            candidateIds.push(takerOrderId);
          }
        };
        collect(first.items);
        if (first.hasMore && first.nextCursor) {
          let pages = 1;
          for await (const page of paginator.from(first.nextCursor)) {
            collect(page.items);
            if (++pages >= MAX_TRADE_PAGES) {
              if (page.hasMore) incomplete = true;
              break;
            }
          }
        }
      } catch {
        incomplete = true;
      }

      const unique = [...new Set(candidateIds)];
      if (unique.length > MAX_CANDIDATES) incomplete = true; // an unchecked candidate may be ours
      for (const orderId of unique.slice(0, MAX_CANDIDATES)) {
        try {
          const raw = (await fetchOrder(client as never, { orderId })) as Record<string, unknown> | null;
          if (!raw || typeof raw !== "object") continue;
          if (matches(raw)) return { orderId, order: raw };
          // A taker order of THIS wallet, on THIS token, inside the window — and yet the identity
          // test said no. That may be an unrelated order the user placed on polymarket.com, or it
          // may be ours failing a check that is stricter than the exchange's own formatting (the
          // size comparison is exact to a micro-share; if the CLOB ever reports fewer decimals,
          // this is where it shows). Declaring absence here would KILL an attempt whose money the
          // exchange already spent, so an unattributed order of ours is ambiguity, not absence.
          if (String(raw.makerAddress ?? "").toLowerCase() === depositWallet) incomplete = true;
        } catch {
          incomplete = true; // a candidate we could not read may be the one
        }
      }

      // Every read landed and nothing of ours is unaccounted for: the exchange genuinely has no
      // order here, so nothing was posted and no money moved.
      return incomplete ? null : { orderId: null };
    } catch {
      return null; // indeterminate exchange state — no state change is safe
    }
  };

  return { probe, discover };
}
