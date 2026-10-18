-- 003-jobs.sql: Durable job queue, leases, attempts, and completion pinning

CREATE TABLE IF NOT EXISTS jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_type TEXT NOT NULL CHECK (job_type IN ('BUILD', 'GAME', 'TEST_BUILD', 'TEST_GAME')),
    target_id UUID NOT NULL,
    priority INTEGER NOT NULL DEFAULT 100,
    state TEXT NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED', 'LEASED', 'RUNNING', 'COMPLETION_PENDING', 'SUCCEEDED', 'RETRY_WAIT', 'BLOCKED')),
    fencing_token BIGINT NOT NULL DEFAULT 1,
    deployment_generation INTEGER NOT NULL DEFAULT 1,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    active_lease_id UUID,
    available_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_jobs_claim_queue ON jobs (priority DESC, available_at ASC)
    WHERE state IN ('QUEUED', 'RETRY_WAIT');

CREATE INDEX IF NOT EXISTS idx_jobs_target ON jobs (target_id, job_type);
CREATE INDEX IF NOT EXISTS idx_jobs_reconcile ON jobs (state, updated_at)
    WHERE state IN ('LEASED', 'RUNNING', 'COMPLETION_PENDING');

CREATE TABLE IF NOT EXISTS job_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    fencing_token BIGINT NOT NULL,
    grant_id UUID NOT NULL DEFAULT gen_random_uuid(),
    worker_id TEXT NOT NULL,
    lease_expires_at TIMESTAMPTZ NOT NULL,
    heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'EXPIRED', 'COMPLETED', 'FAILED')),
    evidence_digest TEXT,
    error_details TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(job_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_job_attempts_lease ON job_attempts (job_id, fencing_token)
    WHERE state = 'ACTIVE';

CREATE TABLE IF NOT EXISTS job_completions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    attempt_id UUID NOT NULL REFERENCES job_attempts(id) ON DELETE CASCADE,
    fencing_token BIGINT NOT NULL,
    deployment_generation INTEGER NOT NULL,
    evidence_digest TEXT NOT NULL,
    evidence_payload JSONB NOT NULL,
    state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'ACCEPTED', 'REJECTED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    accepted_at TIMESTAMPTZ,
    UNIQUE(job_id, attempt_id)
);

CREATE INDEX IF NOT EXISTS idx_job_completions_state ON job_completions (state);

-- Update schema migration tracking
INSERT INTO schema_migrations (version, name)
VALUES (3, '003-jobs')
ON CONFLICT (version) DO NOTHING;
