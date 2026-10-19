ALTER TABLE job_completions ADD COLUMN result_receipt jsonb;
ALTER TABLE job_completions ADD COLUMN restore_recovery boolean NOT NULL DEFAULT false;
INSERT INTO schema_migrations(version,name) VALUES (24,'024-durable-completion') ON CONFLICT (version) DO NOTHING;
