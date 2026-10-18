-- S05: private TEST create-request window (10 requests per rolling minute, per tournament+team).
--
-- Requests are recorded *before* payload validation so a rejected request still consumes the window;
-- the ledger is a rate limiter, not tournament evidence, so it cascades away with its tournament and
-- prunes attempt rows older than a day. Spec: docs/specs/v2/01-PRODUCT-REQUIREMENTS.md §123.
CREATE TABLE IF NOT EXISTS test_create_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_id UUID NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_test_create_attempts_window
    ON test_create_attempts (tournament_id, team_id, created_at);

-- Schema version tracking
INSERT INTO schema_migrations (version, name)
VALUES (19, '019-test-create-attempts')
ON CONFLICT (version) DO NOTHING;
