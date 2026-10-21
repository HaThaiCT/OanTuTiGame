-- Online team policy metadata does not rewrite LAN teams or historical rosters.
ALTER TABLE teams ADD COLUMN tournament_id UUID REFERENCES tournaments(id) ON DELETE RESTRICT;
ALTER TABLE teams ADD COLUMN closed_at TIMESTAMPTZ;
CREATE INDEX teams_tournament_policy ON teams(tournament_id) WHERE tournament_id IS NOT NULL;

CREATE TABLE team_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE RESTRICT,
  recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  invited_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACCEPTED','DECLINED','REVOKED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (clock_timestamp() + interval '48 hours'),
  responded_at TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX team_invitation_pending_recipient ON team_invitations(team_id,recipient_user_id) WHERE status='PENDING';
CREATE INDEX team_invitation_private_inbox ON team_invitations(recipient_user_id,created_at DESC);

ALTER TABLE tournament_entry_codes ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0);
ALTER TABLE tournament_entry_codes ADD COLUMN revoked_at TIMESTAMPTZ;
-- Legacy installations may have issued multiple codes; retain only the newest active code.
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY tournament_id ORDER BY created_at DESC,id DESC) AS ordinal
  FROM tournament_entry_codes
)
UPDATE tournament_entry_codes code SET revoked_at=clock_timestamp()
FROM ranked WHERE code.id=ranked.id AND ranked.ordinal>1;
CREATE UNIQUE INDEX tournament_entry_code_one_active ON tournament_entry_codes(tournament_id) WHERE revoked_at IS NULL;
ALTER TABLE tournament_admissions ADD COLUMN entry_code_id UUID REFERENCES tournament_entry_codes(id) ON DELETE RESTRICT;
ALTER TABLE tournament_admissions ADD COLUMN entry_code_revision INTEGER CHECK (entry_code_revision > 0);
ALTER TABLE tournament_admissions ADD CONSTRAINT admission_code_provenance_pair CHECK ((entry_code_id IS NULL) = (entry_code_revision IS NULL));

-- Keys contain SHA-256 of purpose/actor or purpose/IP, never raw identifying values.
CREATE TABLE entry_code_attempts (
  key_hash TEXT PRIMARY KEY,
  window_start TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts > 0)
);

INSERT INTO schema_migrations(version,name) VALUES (29,'029-online-team-lifecycle') ON CONFLICT (version) DO NOTHING;
