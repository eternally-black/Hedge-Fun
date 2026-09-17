# Stocklana — submission packet

What the form asks for, where the proof is, and the one command that checks each claim.
Product write-up and the full on-chain proof tables: [stocklana.md](stocklana.md).

## Requirement → evidence

| Requirement | Evidence | Check |
|---|---|---|
| Working product, publicly usable | https://app.hedgeyour.fun — email login, Stocks deck, Portfolio, Hedge, Profile | open it; no wallet or SOL needed |
| Tokenized stocks on Solana | xStocks (Backed, Token-2022) catalog of ≈930 assets, 44 with a Solana pool dealt for real | `curl -s https://app.hedgeyour.fun/api/stocks/health` → `"assets":9xx,"deckFresh":150` |
| Real on-chain trades | 18 mainnet transactions in [stocklana.md](stocklana.md#on-chain-proof-mainnet-fee-sponsored): embedded wallet and a connected Phantom, buys and sells, fee-sponsored | any Solscan link there |
| Onboarding without a wallet | Privy embedded Solana wallet created at email login; the app's fee-payer co-signs every trade; a user needs USDC only | `src/app/providers.tsx`, `src/lib/sponsor.ts` |
| Works with a wallet the user already has | Phantom connected on Profile → Wallet; its existing xStocks imported as lots; its transaction rewrite (Lighthouse guards) accepted; its own rent | proof table 3; `scripts/test-stocks.ts` (16 guard cases), `scripts/test-stocks-real-db.ts` (12b, 11b) |
| Paper and real behind one control | Profile → Mode switch; the same card, swipe, Sell row and hedge card change economy | [README](../README.md#tokenized-stocks-stocklana) table |
| Money safety | server-built attempt matched on confirm; co-sign only our message (+ guards); per-user daily cap on sent transactions; lots reconciled against the wallet | `npm run test:db` |
| Monitoring | public probe 503 on a stale deck or a drained fee-payer; poller pages Telegram | `curl -s https://app.hedgeyour.fun/api/stocks/health` |
| Tests in CI | 6 unit suites + 4 DB suites on every push to `main`; deploy only after they pass | `.github/workflows/deploy.yml`, `npm test`, `npm run test:db` |
| Open source | this repository, default branch `main` holds the deployed state | `git log -1 origin/main` matches the app's deploy run |

## Verify in three commands

```bash
npm test
npm run test:db
curl -s https://app.hedgeyour.fun/api/stocks/health
```

## Human steps (account-bound, not the agent's)

- [ ] Record the demo video: Paper swipe → Profile → Real → swipe buys on Solana → Portfolio → Sell → Hedge chip.
- [ ] Fill the submission form: live URL, repo URL, video, the three proof links (one embedded buy, one Phantom buy, one sell).
- [ ] Repository visibility as the form requires.
- [ ] Privy: upgrade the app to production (150-user cap in Development mode).
- [ ] Fee-payer top-up when the probe or Telegram says so (`71TSncjaoA9S7WCpANR5TqD8MeRMEexZEnKDTzD9r6oi`).
