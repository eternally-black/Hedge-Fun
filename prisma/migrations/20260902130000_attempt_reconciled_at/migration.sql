-- OrderAttempt.reconciledAt: set once the exchange's terminal trade records have been booked and
-- the fee trued up; the stuck-attempt sweep skips such rows so a fully booked attempt is not
-- probed again every pass for 48h.
ALTER TABLE "order_attempts" ADD COLUMN "reconciledAt" TIMESTAMP(3);
