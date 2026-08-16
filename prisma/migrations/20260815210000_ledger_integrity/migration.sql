-- Two ledger-integrity gaps, both invisible to the app until they had already cost something.

-- 1) PointsLedger.betId was a bare unique column with NO foreign key (ShardGrant.betId has had a real
-- one since 0_init), so a point credit could name a bet that never existed — or another user's bet —
-- and the database had no opinion. points_ledger has LIVE rows, so the constraint goes in NOT VALID:
-- it is enforced on every INSERT/UPDATE from here on (which is the entire leak) while pre-existing
-- rows are not scanned, so this migration cannot fail on legacy data and takes no full-table scan
-- under lock. NOT VALID was chosen over "clean orphans first" because deleting audit rows inside a
-- migration is irreversible and the orphan set is unknown from here. Ops closes it out when convenient:
--   SELECT p."id" FROM "points_ledger" p LEFT JOIN "bets" b ON b."id" = p."betId"
--     WHERE p."betId" IS NOT NULL AND b."id" IS NULL;   -- expect 0 rows
--   ALTER TABLE "points_ledger" VALIDATE CONSTRAINT "points_ledger_betId_fkey";
-- ON DELETE SET NULL is the Prisma default for an optional relation (keeps schema.prisma in sync):
-- deleting a bet keeps the already-awarded points row and drops only its provenance link.
ALTER TABLE "points_ledger" ADD CONSTRAINT "points_ledger_betId_fkey"
  FOREIGN KEY ("betId") REFERENCES "bets"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

-- 2) RelayerTx.txHash (the relayer transactionId) had no unique index — the only unique was
-- (userId, kind, workflowKey), and workflowKey is the per-RUN id. An idempotent relayer returning the
-- SAME transactionId for a re-submitted request therefore records one confirmed money movement on two
-- rows, and the 100/day budget ledger counts rows: one movement charged twice.
-- A PLAIN unique index is exactly the "unique where non-null" the fix calls for — Postgres treats
-- NULLs as distinct, and every SUBMITTING/failed row carries NULL. Written plain rather than
-- "... WHERE txHash IS NOT NULL" so Prisma can express it natively as @unique and the schema cannot
-- drift from the database (the partial form would only survive as a comment, like
-- funding_attempts_one_active).
-- De-dup defensively first so the index build cannot fail on live rows: keep the EARLIEST row's id,
-- null the later twins. Nulled and not deleted — the row is a budget-ledger entry, and deleting it
-- would silently hand back spend; a NULL drops only the duplicated external link.
UPDATE "relayer_txs" t SET "txHash" = NULL
WHERE t."txHash" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "relayer_txs" o
    WHERE o."txHash" = t."txHash" AND (o."createdAt", o."id") < (t."createdAt", t."id")
  );
CREATE UNIQUE INDEX "relayer_txs_txHash_key" ON "relayer_txs"("txHash");

-- WalletWorkflow.txHash holds the same external id and gets the same index. It is free there: the
-- single-flight row is reset to txHash=NULL at the start of every run, so a re-run rewrites its OWN
-- row and cannot collide with itself; a collision across two rows would mean one relayer submission is
-- bound to two state machines — the ambiguity convergence must never be asked to resolve. Same
-- defensive de-dup, for the same reason.
UPDATE "wallet_workflows" t SET "txHash" = NULL
WHERE t."txHash" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "wallet_workflows" o
    WHERE o."txHash" = t."txHash" AND (o."createdAt", o."id") < (t."createdAt", t."id")
  );
CREATE UNIQUE INDEX "wallet_workflows_txHash_key" ON "wallet_workflows"("txHash");
