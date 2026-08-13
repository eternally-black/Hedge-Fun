-- S4 rework (cross-review): live-generator sessions keyed by a per-run id; RelayerTx rows are
-- per run (workflowKey = runId), so the budget ledger survives single-flight slot reuse.
ALTER TABLE "wallet_workflows" ADD COLUMN "runId" TEXT;
