-- 016-session-reauth.sql: recent re-authentication for destructive organizer actions
--
-- The organizer surface used to take a session cookie as sufficient proof for actions that cannot
-- be undone by the operator afterwards: starting, pausing, resuming, finalizing, reopening, closing
-- registration, setting the appeal window, setting the round grace period and applying a result
-- correction. A cookie left behind on a shared lab machine was therefore enough to finalize a
-- tournament or void a result.
--
-- Those routes now also require the operator to re-enter their own password within the last 10
-- minutes. The confirmation is recorded on the *session row* (`sessions.reauthenticated_at`), not on
-- the user, so:
--
--   * every session starts unconfirmed (`NULL`), including sessions that existed before this
--     migration, and the UI asks for the password the first time such an action is attempted;
--   * re-confirming one session never unlocks another — a second device must confirm separately;
--   * the window is evaluated against `clock_timestamp()` on the server, so nothing the client sends
--     (body, header or clock) can extend it. `POST /api/v2/auth/reauth` is the only writer, and it
--     requires the account password (`IdentityService.reauthenticate`); the check lives in
--     `IdentityService.assertRecentReauth`, which the guarded routes call after their ADMIN check.
--
-- No index is added: the guard reads the session by its existing unique `token_hash`, and the
-- expiration comparison is a filter on a column already being fetched.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS reauthenticated_at TIMESTAMPTZ;

-- Schema version tracking
INSERT INTO schema_migrations (version, name)
VALUES (16, '016-session-reauth')
ON CONFLICT (version) DO NOTHING;
