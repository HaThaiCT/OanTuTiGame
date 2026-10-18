-- 005-maps-and-stages.sql: Maps, map pool, and frozen entry submission pointers

CREATE TABLE IF NOT EXISTS maps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    descriptor JSONB NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'PUBLIC' CHECK (visibility IN ('PUBLIC', 'HIDDEN')),
    validation_warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
    revealed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_maps_visibility ON maps(visibility);

CREATE TABLE IF NOT EXISTS tournament_map_pool (
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    map_id UUID NOT NULL REFERENCES maps(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tournament_id, map_id)
);

-- Add frozen_submission_id to tournament_entries if not present
ALTER TABLE tournament_entries
ADD COLUMN IF NOT EXISTS frozen_submission_id UUID REFERENCES submissions(id) ON DELETE RESTRICT;

-- Add lock & appeal metadata columns to tournaments
ALTER TABLE tournaments
ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS registration_closes_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS appeal_window_minutes INTEGER NOT NULL DEFAULT 1440;

-- Schema version tracking
INSERT INTO schema_migrations (version, name)
VALUES (5, '005-maps-and-stages')
ON CONFLICT (version) DO NOTHING;
