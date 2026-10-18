-- 007-disputes-and-corrections.sql: Disputes ledger, result corrections, and finalization metadata

ALTER TABLE tournaments
ADD COLUMN IF NOT EXISTS provisional_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS disputes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    encounter_id UUID NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
    created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'UNDER_REVIEW', 'RESOLVED', 'REJECTED')),
    reason TEXT NOT NULL,
    decision TEXT,
    decided_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_disputes_tournament ON disputes(tournament_id, status);
CREATE INDEX IF NOT EXISTS idx_disputes_encounter ON disputes(encounter_id);

CREATE TABLE IF NOT EXISTS result_corrections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    from_result_version_id UUID NOT NULL REFERENCES result_versions(id) ON DELETE RESTRICT,
    to_result_version_id UUID REFERENCES result_versions(id) ON DELETE RESTRICT,
    action TEXT NOT NULL CHECK (action IN ('VOID', 'REJUDGE')),
    reason TEXT NOT NULL,
    authorized_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    preview_digest TEXT NOT NULL,
    impact_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_corrections_game ON result_corrections(game_id);

-- Schema version tracking
INSERT INTO schema_migrations (version, name)
VALUES (7, '007-disputes-and-corrections')
ON CONFLICT (version) DO NOTHING;
