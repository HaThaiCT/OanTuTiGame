-- 004-results.sql: Game records, result versions, accepted results, and replay objects

CREATE TABLE IF NOT EXISTS encounters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    round_ordinal INTEGER NOT NULL DEFAULT 1,
    slot_ordinal INTEGER NOT NULL DEFAULT 1,
    team_a_id UUID NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
    team_b_id UUID NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'CANCELLED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_encounters_lookup ON encounters(tournament_id, round_ordinal, slot_ordinal);

CREATE TABLE IF NOT EXISTS games (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    encounter_id UUID NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
    game_ordinal INTEGER NOT NULL,
    white_team_id UUID NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
    black_team_id UUID NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
    map_descriptor JSONB NOT NULL,
    rules_revision TEXT NOT NULL DEFAULT 'ArenaGameplay/v2',
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'CANCELLED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(encounter_id, game_ordinal)
);

CREATE INDEX IF NOT EXISTS idx_games_encounter ON games(encounter_id, game_ordinal);

CREATE TABLE IF NOT EXISTS replay_objects (
    digest TEXT PRIMARY KEY,
    storage_path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    total_turns INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS result_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 1,
    verdict TEXT NOT NULL CHECK (verdict IN ('DECISIVE', 'DRAW', 'NO_CONTEST')),
    winner INTEGER, -- 0 = unspecified/draw, 1 = white, 2 = black
    reason TEXT NOT NULL,
    disposition TEXT NOT NULL DEFAULT 'DECISIVE',
    action_trace_digest TEXT NOT NULL,
    replay_digest TEXT NOT NULL REFERENCES replay_objects(digest) ON DELETE RESTRICT,
    manifest_digest TEXT NOT NULL,
    cpu_usec BIGINT NOT NULL DEFAULT 0,
    wall_usec BIGINT NOT NULL DEFAULT 0,
    trace JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(game_id, revision)
);

CREATE TABLE IF NOT EXISTS accepted_results (
    game_id UUID PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
    result_version_id UUID NOT NULL REFERENCES result_versions(id) ON DELETE RESTRICT,
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Schema version tracking
INSERT INTO schema_migrations (version, name)
VALUES (4, '004-results')
ON CONFLICT (version) DO NOTHING;
