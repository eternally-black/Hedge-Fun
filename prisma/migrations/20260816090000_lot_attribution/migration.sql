-- Two attribution gaps that only bite AFTER a position is reopened or an attempt is orphaned.
-- Additive and nullable/defaulted throughout: nothing here can fail on an existing row, and nothing
-- rewrites data, so this migration is safe to deploy ahead of the code that reads the columns.

-- 1) Bet.lotSeq / OrderAttempt.lotSeq — WHICH LOT the fill counters describe.
-- A fully-closed REAL position is re-enterable (the intent route admits an ENTRY whenever the
-- remainder is zero), and the re-entry reuses the same bets row with filledSharesMicro,
-- closedSharesMicro, proceedsMicro and closeFeeMicro all reset to the new lot. That reset is
-- correct for the new position and destroys the basis of the old one: trueUpAttemptFee reads
-- closed/filled off this row to restate the realized slice when the exchange's charged fee finally
-- replaces the estimate, so after a reopen it prorates against the WRONG lot — the correction lands
-- on a basis that never paid it, and the closed lot keeps a realized PnL computed from a fee now
-- known to be wrong. Stamping the lot on both sides lets the true-up notice and decline.
-- DEFAULT 0 on bets: every existing row is lot 0, which is exactly what the attempts below claim.
ALTER TABLE "bets" ADD COLUMN "lotSeq" INTEGER NOT NULL DEFAULT 0;
-- NULL on order_attempts means "booked before lot tracking existed". The reader treats null as
-- "assume it matches" rather than "refuse", so historical attempts keep todays behaviour and only
-- newly-booked ones gain the guarantee — a stricter default would start rejecting true-ups for
-- every attempt already in flight at deploy time.
ALTER TABLE "order_attempts" ADD COLUMN "lotSeq" INTEGER;

-- 2) OrderAttempt.signedOrder — the payload that was actually signed, written at CAS time.
-- An attempt that reaches SUBMITTING and then crashes before the POSTED write has no
-- externalOrderId, and every reconcile scan filters on that column being non-null — so the row is
-- invisible to reconciliation, never expires, and holds the one-in-flight slot for that market
-- forever. If the order did match, the position exists on the exchange and not in the app, and EXIT
-- answers no_position. Persisting the payload does not make recovery automatic (the SDK exports no
-- helper to derive the exchange order id from a signed order), but it is the difference between an
-- operator being able to reconstruct what happened and not being able to.
ALTER TABLE "order_attempts" ADD COLUMN "signedOrder" JSONB;
