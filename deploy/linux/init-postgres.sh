#!/bin/sh
set -eu
# Only runs for an empty PostgreSQL volume. Existing deployments require an explicit migration.
app_password=$(cat /run/secrets/pg_app_password)
if [ -z "$app_password" ]; then
  echo 'Application database secret must not be empty' >&2
  exit 1
fi
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=app_password="$app_password" <<'SQL'
SELECT format('CREATE ROLE arena_app LOGIN PASSWORD %L', :'app_password') \gexec
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE ROLE arena_migrator NOLOGIN;
GRANT CONNECT ON DATABASE arena TO arena_app;
GRANT USAGE, CREATE ON SCHEMA public TO arena_migrator;
SQL
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
CREATE TABLE IF NOT EXISTS migration_checksums (
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
SQL
for migration in /opt/arena-migrations/*.sql; do
  version=${migration##*/}; version=${version%%-*}
  checksum=$(sha256sum "$migration" | cut -d ' ' -f 1)
  {
    printf 'BEGIN; SET ROLE arena_migrator;\n'
    cat "$migration"
    printf "\nRESET ROLE; INSERT INTO migration_checksums(version, checksum) VALUES (%s, '%s');\nCOMMIT;\n" "$version" "$checksum"
  } | psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB"
done
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
BEGIN;
GRANT USAGE ON SCHEMA public TO arena_app;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM arena_app;
SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO arena_app', tablename)
FROM pg_tables WHERE schemaname = 'public'
  AND tablename NOT IN ('schema_migrations', 'migration_checksums', 'audit_events', 'backup_identity', 'backup_checkpoints') \gexec
GRANT SELECT ON schema_migrations, migration_checksums, backup_identity, backup_checkpoints TO arena_app;
GRANT SELECT, INSERT ON audit_events TO arena_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO arena_app;
COMMIT;
SQL
