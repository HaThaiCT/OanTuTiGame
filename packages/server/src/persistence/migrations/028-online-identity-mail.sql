-- Historical consumed tokens are not evidence of current mailbox verification.
ALTER TABLE users ADD COLUMN email_verified_at timestamptz;
ALTER TABLE email_verification_tokens ADD COLUMN target_email text;
ALTER TABLE email_verification_tokens ADD CONSTRAINT email_verification_purpose CHECK (purpose IN ('EMAIL_VERIFICATION','EMAIL_CHANGE'));
ALTER TABLE password_reset_tokens ADD COLUMN target_email text;
-- Existing queued links have no authenticated delivery custody/address binding: invalidate,
-- never pretend that they were delivered and never backfill verified state.
UPDATE email_verification_tokens SET consumed_at=clock_timestamp() WHERE consumed_at IS NULL;
UPDATE password_reset_tokens SET consumed_at=clock_timestamp() WHERE consumed_at IS NULL;
UPDATE outbox_events SET payload=jsonb_build_object('userId',payload->>'userId','cancelledReason','LEGACY_DELIVERY_INVALIDATED')
WHERE topic IN ('EMAIL_VERIFICATION_REQUESTED','PASSWORD_RESET_REQUESTED','EMAIL_CHANGE_REQUESTED','EMAIL_CHANGED');

CREATE TABLE identity_rate_limits (
  key text NOT NULL,
  window_start timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts >= 0),
  PRIMARY KEY(key,window_start)
);
CREATE TABLE identity_mail_deliveries (
  outbox_id uuid PRIMARY KEY REFERENCES outbox_events(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('EMAIL_VERIFICATION','PASSWORD_RESET','EMAIL_CHANGE','EMAIL_CHANGED')),
  token_hash text,
  expires_at timestamptz NOT NULL,
  envelope jsonb,
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','SENDING','DELIVERED','CANCELLED','EXPIRED','HELD')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_until timestamptz,
  lease_token uuid,
  last_failure text CHECK (last_failure IN ('TRANSPORT_FAILED','MATERIAL_INVALID')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  CHECK ((purpose='EMAIL_CHANGED' AND token_hash IS NULL) OR (purpose<>'EMAIL_CHANGED' AND token_hash IS NOT NULL)),
  CHECK ((state='SENDING') = (lease_until IS NOT NULL AND lease_token IS NOT NULL)),
  CHECK ((state IN ('DELIVERED','CANCELLED','EXPIRED') AND envelope IS NULL) OR (state IN ('PENDING','SENDING','HELD') AND envelope IS NOT NULL))
);
CREATE INDEX identity_mail_due ON identity_mail_deliveries(next_attempt_at) WHERE state IN ('PENDING','SENDING');
CREATE INDEX identity_mail_user_token ON identity_mail_deliveries(user_id,token_hash);
CREATE TRIGGER backup_mutation_barrier BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON identity_rate_limits
  FOR EACH STATEMENT EXECUTE FUNCTION backup_mutation_barrier();
CREATE TRIGGER backup_mutation_barrier BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON identity_mail_deliveries
  FOR EACH STATEMENT EXECUTE FUNCTION backup_mutation_barrier();
INSERT INTO schema_migrations(version,name) VALUES(28,'028-online-identity-mail') ON CONFLICT(version) DO NOTHING;
