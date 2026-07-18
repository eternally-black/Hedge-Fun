-- Hedge telemetry: record the ACTUAL locked stake on ACCEPT (F16). Additive only: one nullable
-- column on hedge_suggestion_events. proposedStakeCents (the offered/sized stake) is unchanged;
-- actualStakeCents is the stake actually locked after the per-user Cash clamp, so funnel analytics
-- no longer overstate accepted notional. Null on existing rows / IMPRESSION / DISMISS. No existing
-- column/flow changes. Hand-written to match schema.prisma; applied by `prisma migrate deploy`.

-- AlterTable
ALTER TABLE "hedge_suggestion_events" ADD COLUMN     "actualStakeCents" INTEGER;
