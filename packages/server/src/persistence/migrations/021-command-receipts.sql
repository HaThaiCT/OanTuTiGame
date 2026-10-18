-- S09: durable command receipts. A mutation retried with the same scope + idempotency key and the same
-- payload must return the canonical receipt instead of repeating the effect (double click, lost ack),
-- while the same key with a different payload is a conflict. 03-ARCHITECTURE-DATA-CONTRACTS §166.
CREATE TABLE IF NOT EXISTS command_receipts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    payload_digest TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DONE')),
    receipt JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (actor_user_id, scope, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_command_receipts_key ON command_receipts (idempotency_key);

-- Schema version tracking
INSERT INTO schema_migrations (version, name)
VALUES (21, '021-command-receipts')
ON CONFLICT (version) DO NOTHING;
