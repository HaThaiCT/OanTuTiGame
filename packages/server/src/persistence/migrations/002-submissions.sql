-- 002-submissions.sql: Immutable submission source store, receipts, and private test snapshots

CREATE TABLE IF NOT EXISTS submission_sources (
    digest TEXT PRIMARY KEY,
    storage_path TEXT NOT NULL,
    zip_bytes INTEGER NOT NULL,
    expanded_bytes INTEGER NOT NULL,
    file_count INTEGER NOT NULL,
    manifest JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS submissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
    submitted_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    receipt_ordinal INTEGER NOT NULL,
    source_digest TEXT NOT NULL REFERENCES submission_sources(digest) ON DELETE RESTRICT,
    language TEXT NOT NULL CHECK (language IN ('PYTHON', 'TYPESCRIPT', 'CPP')),
    entrypoint TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'VALIDATING' CHECK (status IN ('VALIDATING', 'QUEUED', 'COMPILING', 'SMOKE_TESTING', 'READY', 'REJECTED')),
    reject_reason TEXT,
    received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(tournament_id, team_id, receipt_ordinal)
);

CREATE INDEX IF NOT EXISTS idx_submissions_lookup ON submissions(tournament_id, team_id, receipt_ordinal DESC);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);

CREATE TABLE IF NOT EXISTS test_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    source_digest TEXT NOT NULL REFERENCES submission_sources(digest) ON DELETE RESTRICT,
    language TEXT NOT NULL CHECK (language IN ('PYTHON', 'TYPESCRIPT', 'CPP')),
    entrypoint TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_test_snapshots_team ON test_snapshots(team_id, created_at DESC);

-- Update schema migration tracking
INSERT INTO schema_migrations (version, name)
VALUES (2, '002-submissions')
ON CONFLICT (version) DO NOTHING;
