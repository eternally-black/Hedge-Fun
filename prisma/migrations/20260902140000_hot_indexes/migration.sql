-- hot filters: /api/history sorts by createdAt after filtering on userId
CREATE INDEX "bets_userId_createdAt_idx" ON "bets"("userId", "createdAt");

-- hot filters: /api/results sorts by settledAt after filtering on userId
CREATE INDEX "bets_userId_settledAt_idx" ON "bets"("userId", "settledAt");

-- hot filters: prune-markets anti-joins on resolutionDeadline every 5 min
CREATE INDEX "markets_resolutionDeadline_idx" ON "markets"("resolutionDeadline");
