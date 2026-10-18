-- 011-private-test-results.sql: durable outcome of a private TEST run
--
-- A private test plays a real match, but it must leave zero official trace: no receipt ordinal,
-- no accepted result, no standings/rating row, no frozen tournament candidate. Its outcome
-- therefore lives entirely on the snapshot row it was launched from — the JSONB result payload
-- (winner/reason/turns/opponent/map), the digest of the immutable replay promoted for it, and
-- the two timestamps of the run itself.
--
-- The snapshot's status keeps the 009 state machine and gains the execution leg:
--   QUEUED → COMPILING → SMOKE_TESTING → COMPLETED → RUNNING → COMPLETED (result_payload)
--                                                            ↘ FAILED    ({error} in payload)
-- `completed_at` already exists (008); it is re-declared here so this migration is a
-- self-contained description of the private-test result columns and is safe to re-run.

ALTER TABLE test_snapshots
ADD COLUMN IF NOT EXISTS result_payload JSONB,
ADD COLUMN IF NOT EXISTS replay_digest TEXT,
ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- Serves the team-scoped private-test history (`WHERE tournament_id = $1 AND team_id = $2
-- ORDER BY created_at DESC`), which the per-team index of 002 cannot cover.
CREATE INDEX IF NOT EXISTS idx_test_snapshots_tournament_team
ON test_snapshots(tournament_id, team_id, created_at DESC);

-- Schema version tracking
INSERT INTO schema_migrations (version, name)
VALUES (11, '011-private-test-results')
ON CONFLICT (version) DO NOTHING;
