# Credential rotation — request to the account owner

**Who this is for:** whoever holds the Privy dashboard and the Polymarket builder account. The
engineering side cannot do any of this: both actions need console/account ownership, and neither
should ever pass through a developer's hands.

**Why now:** an older set of Polymarket builder credentials and a throwaway spike-wallet key were
pasted into a chat transcript, so both must be treated as public. The real-money layer is code-
complete and blocked on this one item before any live funds move.

---

## 1. Polymarket builder API credentials — REQUIRED before live money

**What leaked:** `POLYMARKET_BUILDER_API_KEY`, `POLYMARKET_BUILDER_SECRET`,
`POLYMARKET_BUILDER_PASSPHRASE`. The public `POLYMARKET_BUILDER_CODE` (attribution tag) is not a
secret and does not need to change.

**Blast radius while the old key lives:** anyone holding the transcript can (a) spend our gasless
relayer quota — roughly 100 sponsored transactions/day on the unverified tier, i.e. a denial of
onboarding for real users; (b) attribute their own trading volume to us, which risks Polymarket
flagging or suspending the builder account; (c) call `DELETE /auth/builder-api-key` and revoke the
key outright, which takes our own app down with it. It does **not** give access to anyone's funds.

**How to rotate.** The credentials are issued by the CLOB against the builder account's own wallet,
so the rotation must be signed by that wallet. Two paths:

- **Preferred — Polymarket contact:** ask `builder@polymarket.com` (or whoever issued the current
  key) to rotate and to confirm whether `POLYMARKET_BUILDER_CODE` stays the same.
- **Self-serve:** the SDK exposes `createBuilderApiKey` / `fetchBuilderApiKeys` /
  `revokeBuilderApiKey`, all authenticated by the builder wallet's signature. Engineering can
  prepare a one-page browser tool that connects the builder wallet, creates the new key and shows
  it on the owner's screen only — the private key never leaves the owner's wallet and no developer
  ever sees the result. Say the word and it gets built.

**Order of operations — do not skip:** create the new key → put it into the deployment environment →
restart → confirm a builder-signed request succeeds → **only then** revoke the old key. Revoking
first means an outage; revoking last means the leaked key is live for the length of the window, so
keep that window short (minutes, not days).

---

## 2. Privy app secret — recommended, not blocking

**What it is:** `PRIVY_APP_SECRET`. It is not known to have leaked; rotate it as hygiene, or skip it
and say so, so nobody assumes it was done.

**Steps:** Privy dashboard → **Settings → Basics** → reset the app secret. It is displayed **once**
— Privy does not store it and cannot recover it. The app **ID** is immutable and needs no change,
and the verification key is separate.

**Timing matters more than usual here:** every authenticated request in the app is verified through
a Privy client built from the app id + secret, so a reset with a stale environment can 401 the whole
product. Reset and update the environment in the same sitting, not "later today".

---

## 3. Spike wallet — nothing to rotate

The throwaway EOA in the old spike directory cannot be rotated, only abandoned: move any remaining
balance off it and never use it again. No production code references it; the contract addresses in
the codebase were pinned against a production transaction, not against that wallet.

---

## 4. How to hand the new values over — pick one

Never chat, email, ticket comments, or screenshots. In order of preference:

1. **Owner writes them directly** into `/opt/hedgefun/.env` on the app server (mode 600), then
   restarts. Nobody else ever holds the values. Best option if the owner has server access.
2. **Password-manager share** (1Password/Bitwarden item shared with the operator), which is what the
   assistant tooling here is designed around: the vault fills secrets, nothing is retyped.
3. **One-time secret link** (e.g. a self-destructing note service) as a last resort, with the link
   sent over a different channel than the notice that it exists.

The values are needed in exactly two places — the app server's `/opt/hedgefun/.env`, and a
developer's local `.env.local` **only if** live testing must be run locally. GitHub secrets hold the
public Privy app id only and do not change.

---

## 5. Verification after the swap (no secret ever printed)

Run on the box that got the new values:

```bash
node -e 'for (const k of ["PRIVY_APP_SECRET","POLYMARKET_BUILDER_API_KEY","POLYMARKET_BUILDER_SECRET","POLYMARKET_BUILDER_PASSPHRASE","POLYMARKET_BUILDER_CODE"]) { const v=process.env[k]; console.log(k.padEnd(32), v ? `set (${v.length} chars, ...${v.slice(-4)})` : "MISSING"); }'
```

The 4-character tail is there so two machines can be compared without either side revealing a
secret. After that, one builder-signed request has to succeed — the real-money console at `/real`
exercises it end to end, and a dedicated check script can be added if a quieter signal is wanted.

---

## 6. What stays blocked until item 1 is done

Live acceptance of the real-money path: deposit-wallet deployment, the gasless relay (wrap,
approvals, redeem, withdraw) and builder-attributed order posting all authenticate with the builder
credentials. Everything else — the code, the tests, the console UI — is finished and green.
