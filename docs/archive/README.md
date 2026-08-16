# Archive

Work that was removed from the live codebase but is worth keeping recoverable.

## TxOdds TxLINE World Cup integration

Live football on top of the Polymarket core: a global ticker (бегущая строка), a ⚽ Cup hub,
Over/Under + "team to win" markets as `Market` rows with `source = TXODDS`, and settlement on
Solana-anchored TxLINE scores with a ⛓ badge on the result.

Shipped 2026-06-29, **removed 2026-08-03**. Full record — including the one-time on-chain
`subscribe()` + `activate` bootstrap that mints the API token, the verified TxLINE API facts, and
the ops runbook — is in [txline-football.md](txline-football.md).

**Why it went:** the World Cup ended 2026-07-19 and the TxLINE subscription (4-week term) had
expired. Prod was logging `TxLine 403 for /fixtures/snapshot` every minute and refreshing 0 markets;
the ticker was already rendering empty. All 7 remaining TXODDS markets were `RESOLVED` with 0
pending bets and 0 locked Cash, so nothing had to be drained.

### Recovering the source

```bash
git checkout archive/txodds-worldcup -- src/lib/txodds.ts src/lib/ticker-events.ts \
  src/app/screens/Ticker.tsx src/app/screens/FootballScreen.tsx src/app/api/football \
  scripts/refresh-football.ts scripts/settle-football.ts scripts/verify-txline.ts \
  scripts/test-settle-football.ts scripts/test-ticker-events.ts
```

**This is source recovery, not a rollback.** Those files depend on wiring that was changed after the
tag: the poller's `settleOne` branch and tick, `page.tsx`'s football state machine, the `Screen`
union and the ⚽ nav item, `TickerRow`/`FootballMatchResponse` in both `api-types.ts` copies, the
ticker CSS, and the `package.json` script chain. Re-read the tag's diff before wiring anything back.

Still present and deliberately untouched in the live tree:

- the DB shape — `MarketSource.TXODDS`, `Market.source` / `verifiedOnChain` / `onchainRef`, the
  `[source, status, resolutionDeadline]` index, and migration `20260629200350_txodds_football_markets`;
- the bookless-source branches (`authoritativePrices`, `/api/swipe`, `/api/feed/bet`, `/api/quotes`,
  `hedge/accept`, `hedge/suggest`) — four DB test suites ride them as no-CLOB fixtures;
- `verified` / `onchainRef` in the `/api/results` response, emitted as `false` / `null`, per the
  "don't remove/rename in place" rule in `src/lib/api-types.ts`.

So a revival needs no migration and no contract version bump.

Not removed with it, because they serve **Polymarket** soccer and always did: `deck-mix`'s sports
classification, `ui.isFootball`, and the pitch+grass card art in `skins.tsx`.
