-- 006-tournament-rounds.sql: Rounds, standings snapshots, rating events, and encounter progression

-- Allow nullable team_b_id for Byes and add stage / outcome columns to encounters
ALTER TABLE encounters
ALTER COLUMN team_b_id DROP NOT NULL;

ALTER TABLE encounters
ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'MAIN',
ADD COLUMN IF NOT EXISTS winner_team_id UUID REFERENCES teams(id),
ADD COLUMN IF NOT EXISTS points_a NUMERIC(4, 1) NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS points_b NUMERIC(4, 1) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS tournament_rounds (
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    stage TEXT NOT NULL DEFAULT 'MAIN',
    round_ordinal INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('PENDING', 'RUNNING', 'SEAL_ELIGIBLE', 'COMPLETED')),
    last_terminal_at TIMESTAMPTZ,
    seal_eligible_at TIMESTAMPTZ,
    sealed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tournament_id, stage, round_ordinal)
);

CREATE TABLE IF NOT EXISTS standings_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    stage TEXT NOT NULL DEFAULT 'MAIN',
    round_ordinal INTEGER NOT NULL,
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    rank INTEGER NOT NULL,
    points NUMERIC(6, 1) NOT NULL DEFAULT 0,
    matches_played INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    draws INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    buchholz NUMERIC(8, 2) NOT NULL DEFAULT 0,
    sonneborn_berger NUMERIC(8, 2) NOT NULL DEFAULT 0,
    rating_elo NUMERIC(8, 2) NOT NULL DEFAULT 1200.0,
    is_qualified BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (tournament_id, stage, round_ordinal, team_id)
);

CREATE INDEX IF NOT EXISTS idx_standings_lookup ON standings_snapshots(tournament_id, stage, round_ordinal, rank ASC);

CREATE TABLE IF NOT EXISTS rating_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    encounter_id UUID NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    epoch INTEGER NOT NULL,
    pre_rating NUMERIC(8, 2) NOT NULL,
    delta NUMERIC(8, 2) NOT NULL,
    post_rating NUMERIC(8, 2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (tournament_id, encounter_id, team_id)
);

CREATE INDEX IF NOT EXISTS idx_rating_events ON rating_events(tournament_id, epoch);

-- Schema version tracking
INSERT INTO schema_migrations (version, name)
VALUES (6, '006-tournament-rounds')
ON CONFLICT (version) DO NOTHING;
