-- Built-in starter templates are product-owned catalog entries, not owned by a deletable test ADMIN.
-- Admin-uploaded templates continue to record the uploader; deleting that account preserves the template.
ALTER TABLE starter_bot_templates
  ALTER COLUMN created_by_user_id DROP NOT NULL;

ALTER TABLE starter_bot_templates
  DROP CONSTRAINT starter_bot_templates_created_by_user_id_fkey;

ALTER TABLE starter_bot_templates
  ADD CONSTRAINT starter_bot_templates_created_by_user_id_fkey
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL;

UPDATE starter_bot_templates
SET created_by_user_id = NULL
WHERE slug IN ('official-python-starter', 'official-typescript-starter', 'official-cpp-starter');

INSERT INTO schema_migrations(version, name) VALUES (32, '032-starter-bot-seed-author') ON CONFLICT (version) DO NOTHING;
