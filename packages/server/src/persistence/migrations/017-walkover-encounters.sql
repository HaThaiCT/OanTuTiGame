-- Withdrawal/DQ before an encounter starts is recorded as an unplayed encounter instead of a
-- fabricated result: WALKOVER (one active side, no games) or DOUBLE_WITHDRAWAL (both sides gone,
-- 0-0, no rating). Spec: docs/specs/v2/02-GAMEPLAY-TOURNAMENT-RULES.md §124/§126.
ALTER TABLE encounters DROP CONSTRAINT encounters_status_check;
ALTER TABLE encounters ADD CONSTRAINT encounters_status_check CHECK (status = ANY (ARRAY[
  'PENDING'::text,
  'RUNNING'::text,
  'COMPLETED'::text,
  'CANCELLED'::text,
  'BYE'::text,
  'WALKOVER'::text,
  'DOUBLE_WITHDRAWAL'::text
]));
