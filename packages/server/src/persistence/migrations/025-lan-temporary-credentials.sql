ALTER TABLE users ADD COLUMN temporary_password_expires_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN temporary_password_consumed_at TIMESTAMPTZ;
UPDATE users SET temporary_password_expires_at = clock_timestamp() + interval '24 hours'
WHERE activation_method = 'ADMIN_ISSUED' AND password_change_required;

INSERT INTO schema_migrations (version, name)
VALUES (25, '025-lan-temporary-credentials')
ON CONFLICT (version) DO NOTHING;
