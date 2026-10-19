-- Backup inventory and every durable mutation share a transaction-scoped barrier.
CREATE TABLE backup_identity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  deployment_id uuid NOT NULL DEFAULT gen_random_uuid(),
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0)
);
INSERT INTO backup_identity (singleton) VALUES (true);
CREATE TABLE backup_checkpoints (
  manifest_digest text PRIMARY KEY CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
  deployment_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  checkpoint_at timestamptz NOT NULL,
  verification_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  database_digest text NOT NULL CHECK (database_digest ~ '^[a-f0-9]{64}$'),
  restore_lsn pg_lsn NOT NULL,
  object_count integer NOT NULL CHECK (object_count >= 0)
);
REVOKE ALL ON backup_identity, backup_checkpoints FROM PUBLIC;
CREATE FUNCTION backup_publish_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> 'oantuti_backup_verifier' THEN
    RAISE EXCEPTION 'Checkpoint publication requires dedicated verifier role';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER backup_publish_guard BEFORE INSERT OR UPDATE ON backup_checkpoints
FOR EACH ROW EXECUTE FUNCTION backup_publish_guard();
CREATE FUNCTION backup_mutation_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(1868657748, 26);
  RETURN NULL;
END;
$$;
DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    AND tablename NOT IN ('schema_migrations', 'migration_checksums', 'backup_identity', 'backup_checkpoints')
  LOOP
    EXECUTE format('CREATE TRIGGER backup_mutation_barrier BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION backup_mutation_barrier()', item.tablename);
  END LOOP;
END;
$$;
INSERT INTO schema_migrations (version, name) VALUES (26, '026-backup-integrity') ON CONFLICT (version) DO NOTHING;
