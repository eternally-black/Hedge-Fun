// GENERATED from src/lib/real-terms.ts by scripts/sync-mobile-contract.ts — do not edit here.
// The text a user accepts before real money is unlocked, and the version they accepted.
//
// DRAFT — product copy, not lawyer-reviewed. It is written to be honest rather than to be
// protective: every clause below describes something the code actually does, and nothing describes
// a protection that does not exist. Have counsel review it before strangers reach this screen; the
// jurisdiction clause in particular is an assertion by the user, not a control we enforce.
//
// Versioned because "they consented" is worthless without "to what". REAL_TERMS_VERSION is stored
// alongside the acceptance timestamp, so a later change to this file is a NEW consent rather than a
// silent retro-active one. Bump it on any material change.
export const REAL_TERMS_VERSION = "2026-08-16.1";

export interface TermsClause {
  title: string;
  body: string;
}

export const REAL_TERMS_TITLE = "Before you switch to real money";

export const REAL_TERMS_INTRO =
  "Paper mode is a game. Real money mode is not. Read this — it is short, and every line of it " +
  "describes how the app actually behaves.";

export const REAL_TERMS: readonly TermsClause[] = [
  {
    title: "You can lose everything you put in",
    body:
      "These are prediction markets. A position that resolves against you is worth zero — not " +
      "reduced, zero. Only deposit what you are willing to lose entirely.",
  },
  {
    title: "A swipe spends immediately, with no confirmation",
    body:
      "In real money mode a swipe places a real order at once. There is no wallet pop-up and no " +
      "second chance to change your mind — that is deliberate, so the deck still feels like a deck. " +
      "Your daily swipe limit and the stake shown on the card are what bound each one. Withdrawals " +
      "and transfers out still ask you to confirm.",
  },
  {
    title: "Trades are final and settle on a public blockchain",
    body:
      "Orders execute on Polymarket's exchange on the Polygon network. Once a transaction is sent " +
      "it cannot be recalled, reversed or cancelled by us, by you, or by anyone else. A mistyped " +
      "withdrawal address means the funds are gone.",
  },
  {
    title: "We are an interface, not a broker or a custodian",
    body:
      "We do not hold your funds. They sit in a wallet controlled by keys on your own device, and " +
      "the markets, prices, matching and settlement are Polymarket's. We do not set odds, take the " +
      "other side of your trades, or decide outcomes.",
  },
  {
    title: "Nothing here is advice",
    body:
      "Suggested hedges, sizing, and anything the app surfaces about a market are software output, " +
      "not financial, investment, legal or tax advice. No outcome is predicted or promised. What " +
      "you trade is your decision alone.",
  },
  {
    title: "You are responsible for whether this is legal where you are",
    body:
      "Access to prediction markets is restricted or prohibited in some countries and regions, " +
      "including for residents of the United States. By continuing you confirm you may lawfully use " +
      "these markets from where you are. Polymarket applies its own restrictions independently of " +
      "us, and may refuse your orders regardless of what this app allows.",
  },
  {
    title: "Fees and prices move",
    body:
      "The price on a card is a live quote against the order book, not a fixed price, and the " +
      "exchange charges a fee on each fill. The amount shown is the most a swipe may debit; what " +
      "you actually pay depends on what the book does at that moment.",
  },
  {
    title: "This is early software",
    body:
      "The real-money path is new. It can be unavailable, slow, or wrong. Bugs on a money path can " +
      "cost money. If something looks incorrect, stop and contact support from your profile before " +
      "trading further.",
  },
  {
    title: "Withdrawing depends on systems we do not control",
    body:
      "Moving funds out uses a third-party bridge and the Polygon network. Both can be delayed or " +
      "unavailable, and neither is operated by us. Withdrawals have a minimum amount set by the " +
      "bridge, not by this app.",
  },
];

// One-line summary rendered next to the accept control — the thing someone who reads nothing else
// will read. Kept blunt on purpose.
export const REAL_TERMS_ACK =
  "I understand this is real money, that a swipe spends it immediately without confirmation, and " +
  "that I can lose everything I deposit.";
