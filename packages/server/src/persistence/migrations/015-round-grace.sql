-- 015-round-grace.sql: the durable post-round grace window before a round may seal
--
-- A round used to seal the instant its last encounter went terminal, which left no room to
-- file a dispute against that round before the next round's bracket was generated. Now
-- `handleGameCompletion` only marks the round SEAL_ELIGIBLE: it records when the last
-- encounter went terminal (`last_terminal_at`) and when the round may be sealed
-- (`seal_eligible_at = last_terminal_at + tournaments.grace_period_minutes`). The sweep
-- (`TournamentSchedulerService.sealEligibleRounds`, driven by the autonomous worker tick)
-- performs the seal, and holds it open while any dispute on one of the round's encounters is
-- still OPEN/UNDER_REVIEW.
--
-- `grace_period_minutes` is tournament policy and freezes when registration opens (the route
-- only accepts DRAFT/PUBLISHED): a posting deadline must not move under the teams. 0 = seal on
-- the next sweep, 1440 = one day, 10 = the default. Migration 006 already declared the three
-- round timestamps; they are re-declared here so this migration stands alone, and the seal
-- sweep gets a partial index for exactly its predicate.

ALTER TABLE tournaments
ADD COLUMN IF NOT EXISTS grace_period_minutes INTEGER NOT NULL DEFAULT 10;

ALTER TABLE tournaments DROP CONSTRAINT IF EXISTS tournaments_grace_period_minutes_check;
ALTER TABLE tournaments
ADD CONSTRAINT tournaments_grace_period_minutes_check
CHECK (grace_period_minutes >= 0 AND grace_period_minutes <= 1440);

ALTER TABLE tournament_rounds
ADD COLUMN IF NOT EXISTS last_terminal_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS seal_eligible_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS sealed_at TIMESTAMPTZ;

-- Rounds that are due to be sealed, in sweep order: the sweep only ever looks at unsealed
-- rounds that have a seal time, so the index carries the partial predicate verbatim.
CREATE INDEX IF NOT EXISTS idx_tournament_rounds_seal_due
ON tournament_rounds (seal_eligible_at)
WHERE sealed_at IS NULL AND seal_eligible_at IS NOT NULL;

-- Schema version tracking
INSERT INTO schema_migrations (version, name)
VALUES (15, '015-round-grace')
ON CONFLICT (version) DO NOTHING;
