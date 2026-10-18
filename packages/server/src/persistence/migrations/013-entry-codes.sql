-- 013-entry-codes.sql: ONLINE shared multi-use tournament entry codes
-- The plaintext code is shown exactly once at creation; only its SHA-256 hash is stored.

CREATE TABLE IF NOT EXISTS tournament_entry_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL UNIQUE,
    max_uses INTEGER NOT NULL DEFAULT 100 CHECK (max_uses >= 1),
    uses INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0),
    expires_at TIMESTAMPTZ,
    created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT tournament_entry_codes_uses_within_max CHECK (uses <= max_uses)
);

CREATE INDEX IF NOT EXISTS idx_tournament_entry_codes_tournament_id
ON tournament_entry_codes(tournament_id, created_at DESC);

-- Schema version tracking
INSERT INTO schema_migrations (version, name)
VALUES (13, '013-entry-codes')
ON CONFLICT (version) DO NOTHING;
