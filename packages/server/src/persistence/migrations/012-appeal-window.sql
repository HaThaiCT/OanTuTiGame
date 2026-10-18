-- 012-appeal-window.sql: the final-appeal window that gates tournament finalization
--
-- The two pieces of metadata already existed under loose names: 005 added
-- `appeal_window_minutes` (INTEGER NOT NULL DEFAULT 1440) for "lock & appeal" metadata and
-- 007 added `provisional_at` when the scheduler started parking completed tournaments.
-- This migration gives the config its contractual name, pins the legal 0–10080 bound
-- (0 = finalize as soon as the dispute gate clears, 10080 = 7 days), and is self-contained
-- and re-runnable: it re-declares both columns, renames the legacy column only while it still
-- exists, and re-creates the bound idempotently.

ALTER TABLE tournaments
ADD COLUMN IF NOT EXISTS provisional_at TIMESTAMPTZ;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'tournaments'
      AND column_name = 'appeal_window_minutes'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'tournaments'
      AND column_name = 'final_appeal_window_minutes'
  ) THEN
    ALTER TABLE tournaments RENAME COLUMN appeal_window_minutes TO final_appeal_window_minutes;
  END IF;
END $$;

ALTER TABLE tournaments
ADD COLUMN IF NOT EXISTS final_appeal_window_minutes INTEGER NOT NULL DEFAULT 1440;

ALTER TABLE tournaments DROP CONSTRAINT IF EXISTS tournaments_final_appeal_window_minutes_check;
ALTER TABLE tournaments
ADD CONSTRAINT tournaments_final_appeal_window_minutes_check
CHECK (final_appeal_window_minutes >= 0 AND final_appeal_window_minutes <= 10080);

-- Schema version tracking
INSERT INTO schema_migrations (version, name)
VALUES (12, '012-appeal-window')
ON CONFLICT (version) DO NOTHING;
