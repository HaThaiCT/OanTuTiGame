-- Fail rather than silently modifying existing account ownership.
DO $$ BEGIN
  IF (SELECT count(*) FROM users WHERE role = 'ADMIN') > 1 THEN
    RAISE EXCEPTION 'Duplicate ADMIN accounts: explicit operator reconciliation required';
  END IF;
END $$;
CREATE UNIQUE INDEX users_singleton_admin ON users ((role)) WHERE role = 'ADMIN';
ALTER TABLE sessions ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp();
UPDATE sessions SET last_seen_at = created_at;
CREATE TABLE identity_login_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_key text NOT NULL,
  ip_key text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX identity_login_account_window ON identity_login_attempts(account_key, attempted_at);
CREATE INDEX identity_login_ip_window ON identity_login_attempts(ip_key, attempted_at);
-- Single definition shared by authentication, reauthentication and sensitive command gates.
CREATE FUNCTION identity_session_valid(session_row sessions) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT session_row.revoked_at IS NULL
    AND session_row.expires_at > statement_timestamp()
    AND session_row.created_at > statement_timestamp() - interval '7 days'
    AND session_row.last_seen_at > statement_timestamp() - interval '12 hours'
    AND NOT EXISTS (SELECT 1 FROM users WHERE id = session_row.user_id AND role = 'ADMIN'
      AND session_row.created_at <= statement_timestamp() - interval '12 hours')
$$;

INSERT INTO schema_migrations (version, name)
VALUES (22, '022-lan-identity')
ON CONFLICT (version) DO NOTHING;
