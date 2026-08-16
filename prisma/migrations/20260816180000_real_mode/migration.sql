-- Two columns behind the Paper/Real switch in the profile.
--
-- realMode — which economy the user is currently looking at.
-- Server-side rather than client state on purpose: the deck, the balance and the bet list all have
-- to answer per-mode, and a client-only flag would let a stale tab render paper positions under a
-- real-money header — the one place a display bug reads as a money bug.
-- It is NOT an authorisation bit. Every money route re-checks consent and same-origin independently,
-- so flipping this column by hand changes what a user SEES and nothing about what they may spend.
ALTER TABLE "users" ADD COLUMN "realMode" BOOLEAN NOT NULL DEFAULT false;

-- realConsentVersion — WHICH text they accepted, beside the existing realConsentAt.
-- A timestamp alone records that someone clicked, not what they were shown, and the moment the
-- terms change an old acceptance quietly stops meaning what it did. Storing the version makes a
-- terms change a NEW consent instead of a retro-active one.
-- Nullable, and deliberately NOT backfilled: rows that consented before versioning existed genuinely
-- do not know which text they saw, and inventing an answer for them is the one thing this column is
-- meant to prevent. They are treated as needing to accept again.
ALTER TABLE "users" ADD COLUMN "realConsentVersion" TEXT;
