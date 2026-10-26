-- 033-dispute-live-unique.sql: exactly one live dispute per (tournament, encounter, team).
--
-- Filing a dispute was three autocommit statements (state check, INSERT, outbox), so a double click
-- inserted duplicate OPEN rows while a finalize racing the same tournament could commit with an
-- OPEN dispute it never saw. createDispute now runs inside a transaction that holds the
-- tournaments FOR UPDATE lock (the same row finalize locks), re-checks the state in-transaction,
-- and treats a refiling on a live OPEN/UNDER_REVIEW dispute as an idempotent re-create.
-- The partial unique index that backs it is the durable half of that contract.

-- Collapse historical duplicates first: keep the earliest live row per target and drop any later
-- duplicates it spawned, so the partial unique index can be created on migrated data.
DELETE FROM disputes d
USING disputes d2
WHERE d.status IN ('OPEN', 'UNDER_REVIEW')
  AND d2.status IN ('OPEN', 'UNDER_REVIEW')
  AND d.tournament_id = d2.tournament_id
  AND d.encounter_id = d2.encounter_id
  AND d.team_id = d2.team_id
  AND (d.created_at, d.id) > (d2.created_at, d2.id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_disputes_live_per_target
ON disputes (tournament_id, encounter_id, team_id)
WHERE status IN ('OPEN', 'UNDER_REVIEW');

INSERT INTO schema_migrations (version, name)
VALUES (33, '033-dispute-live-unique')
ON CONFLICT (version) DO NOTHING;
