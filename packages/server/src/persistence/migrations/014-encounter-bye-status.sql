-- 014-encounter-bye-status.sql
-- The scheduler persists bye encounters with status 'BYE' (no games, winner set to team A),
-- and its round-completion check treats 'BYE' as terminal, but the original CHECK in
-- 004-results.sql never allowed the value — odd-sized Swiss/elimination fields failed to start.
ALTER TABLE encounters DROP CONSTRAINT IF EXISTS encounters_status_check;
ALTER TABLE encounters ADD CONSTRAINT encounters_status_check
    CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'CANCELLED', 'BYE'));

INSERT INTO schema_migrations (version, name)
VALUES (14, '014-encounter-bye-status')
ON CONFLICT (version) DO NOTHING;
