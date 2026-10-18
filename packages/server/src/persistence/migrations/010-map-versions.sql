-- 010-map-versions.sql: Immutable map versions and tournament map commitments

-- Pointer to the version currently published on `maps.descriptor` (kept in sync by MapService).
ALTER TABLE maps ADD COLUMN IF NOT EXISTS current_version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS map_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    map_id UUID NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    descriptor JSONB NOT NULL,
    validation_warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (map_id, version)
);

-- Backfill version 1 for every map created before versioning existed.
INSERT INTO map_versions (map_id, version, descriptor, validation_warnings)
SELECT id, 1, descriptor, validation_warnings
FROM maps
ON CONFLICT (map_id, version) DO NOTHING;

-- A tournament freezes the exact map version it plays on when registration opens.
CREATE TABLE IF NOT EXISTS tournament_map_commitments (
    tournament_id UUID PRIMARY KEY REFERENCES tournaments(id) ON DELETE CASCADE,
    map_id UUID NOT NULL REFERENCES maps(id) ON DELETE RESTRICT,
    map_version INTEGER NOT NULL,
    committed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    committed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_map_versions_map_version ON map_versions(map_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_tournament_map_commitments_map_id ON tournament_map_commitments(map_id);

-- Schema version tracking
INSERT INTO schema_migrations (version, name)
VALUES (10, '010-map-versions')
ON CONFLICT (version) DO NOTHING;
