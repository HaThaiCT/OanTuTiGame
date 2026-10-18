-- 008-private-tests.sql: Extend test_snapshots with opponent, execution diagnostics, private trace, and quota tracking

ALTER TABLE test_snapshots
ADD COLUMN IF NOT EXISTS opponent_type TEXT NOT NULL DEFAULT 'BASELINE_GREEDY',
ADD COLUMN IF NOT EXISTS opponent_submission_id UUID REFERENCES submissions(id),
ADD COLUMN IF NOT EXISTS map_descriptor JSONB,
ADD COLUMN IF NOT EXISTS result_verdict TEXT,
ADD COLUMN IF NOT EXISTS winner_side INTEGER,
ADD COLUMN IF NOT EXISTS reason TEXT,
ADD COLUMN IF NOT EXISTS total_turns INTEGER,
ADD COLUMN IF NOT EXISTS private_trace JSONB,
ADD COLUMN IF NOT EXISTS build_logs TEXT,
ADD COLUMN IF NOT EXISTS execution_logs TEXT,
ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_test_snapshots_quota ON test_snapshots(team_id, created_at)
WHERE status IN ('QUEUED', 'RUNNING');

-- Schema version tracking
INSERT INTO schema_migrations (version, name)
VALUES (8, '008-private-tests')
ON CONFLICT (version) DO NOTHING;
