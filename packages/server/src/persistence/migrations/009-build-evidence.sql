-- 009-build-evidence.sql: build verdict on receipts and private-test snapshots
--
-- A receipt is only usable once a durable BUILD job has compiled and smoke-tested it, so the
-- verdict needs somewhere to live: the rejection reason, when the build finished, and — for
-- test_snapshots — the two in-flight build states the pipeline walks through.
--
-- test_snapshots.status is widened to match the pipeline's state machine
-- (QUEUED → COMPILING → SMOKE_TESTING → COMPLETED/FAILED); submissions already allowed them.

ALTER TABLE submissions
ADD COLUMN IF NOT EXISTS build_error TEXT,
ADD COLUMN IF NOT EXISTS built_at TIMESTAMPTZ;

ALTER TABLE test_snapshots
ADD COLUMN IF NOT EXISTS build_error TEXT,
ADD COLUMN IF NOT EXISTS built_at TIMESTAMPTZ;

ALTER TABLE test_snapshots DROP CONSTRAINT IF EXISTS test_snapshots_status_check;
ALTER TABLE test_snapshots
ADD CONSTRAINT test_snapshots_status_check
CHECK (status IN ('QUEUED', 'COMPILING', 'SMOKE_TESTING', 'RUNNING', 'COMPLETED', 'FAILED'));

-- Schema version tracking
INSERT INTO schema_migrations (version, name)
VALUES (9, '009-build-evidence')
ON CONFLICT (version) DO NOTHING;
