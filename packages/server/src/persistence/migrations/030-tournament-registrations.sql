-- Online requests are private intake records, never provisional admissions or entries.
CREATE TABLE tournament_registrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  requested_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  reason TEXT CHECK (reason IS NULL OR (length(btrim(reason)) > 0 AND length(reason) <= 500)),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  reviewed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  entry_code_id UUID REFERENCES tournament_entry_codes(id) ON DELETE RESTRICT,
  entry_code_revision INTEGER CHECK (entry_code_revision > 0),
  -- Only an entry excluded by this captain's cancellation may be reactivated by a later approval.
  -- An ADMIN withdrawal/disqualification never grants this provenance.
  cancelled_entry_id UUID REFERENCES tournament_entries(id) ON DELETE RESTRICT,
  UNIQUE(tournament_id,team_id),
  CHECK ((entry_code_id IS NULL) = (entry_code_revision IS NULL)),
  CHECK ((reviewed_at IS NULL) = (reviewed_by_user_id IS NULL)),
  CHECK (status <> 'PENDING' OR (reason IS NULL AND reviewed_at IS NULL)),
  CHECK (status <> 'REJECTED' OR (reason IS NOT NULL AND reviewed_at IS NOT NULL)),
  CHECK (status <> 'APPROVED' OR reviewed_at IS NOT NULL)
);
CREATE INDEX tournament_registrations_queue ON tournament_registrations(tournament_id,status,requested_at,id);
CREATE INDEX tournament_registrations_team ON tournament_registrations(team_id);

-- Existing successful enrollments remain admitted and become cancellable without rewriting
-- their admissions, entry ids, source receipts, or original code provenance.
INSERT INTO tournament_registrations(tournament_id,team_id,requested_by_user_id,reviewed_by_user_id,
  status,requested_at,reviewed_at,updated_at,entry_code_id,entry_code_revision)
SELECT admission.tournament_id,admission.team_id,team.captain_user_id,admission.admitted_by_user_id,
  'APPROVED',admission.created_at,admission.created_at,admission.created_at,admission.entry_code_id,admission.entry_code_revision
FROM tournament_admissions admission JOIN teams team ON team.id=admission.team_id
JOIN tournament_entries entry ON entry.tournament_id=admission.tournament_id AND entry.team_id=admission.team_id
WHERE entry.status='ELIGIBLE';

ALTER TABLE tournament_admissions DROP CONSTRAINT tournament_admissions_admission_type_check;
ALTER TABLE tournament_admissions ADD CONSTRAINT tournament_admissions_admission_type_check
  CHECK (admission_type IN ('DIRECT_ENROLLMENT','INVITE_CODE','REGISTRATION_APPROVAL'));

INSERT INTO schema_migrations(version,name) VALUES (30,'030-tournament-registrations') ON CONFLICT (version) DO NOTHING;
