-- Single-row lease table for the settlement poller (one runner at a time).
--
-- The poller tick runs only while it holds this lease; the lease outlives a tick by one
-- interval so a crashed holder frees it by itself (expiresAt passes and the next runner
-- takes over). One row, id 1 — the row is created on first acquire, never deleted.
CREATE TABLE "poller_lease" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "holder" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "poller_lease_pkey" PRIMARY KEY ("id")
);
