#!/bin/sh
set -eu
# Only runs for an empty PostgreSQL volume. Existing deployments require an explicit migration.
# A separate readiness marker prevents a failed first restore becoming healthy after a restart.
app_password=$(cat /run/secrets/pg_app_password)
if [ -z "$app_password" ]; then
  echo 'Application database secret must not be empty' >&2
  exit 1
fi
psql -X -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=app_password="$app_password" <<'SQL'
SELECT format('CREATE ROLE arena_app LOGIN PASSWORD %L', :'app_password') \gexec
CREATE ROLE arena_migrator NOLOGIN;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE arena TO arena_app;
GRANT USAGE, CREATE ON SCHEMA public TO arena_migrator;
SQL

if [ -f /opt/demo-data/arena_demo.sql.gz ]; then
  echo 'Restoring portable demo database...'
  # Do not pipe gzip into psql: POSIX sh would hide a decompressor failure.
  dump=$(mktemp)
  trap 'rm -f "$dump"' EXIT HUP INT TERM
  gzip -dc /opt/demo-data/arena_demo.sql.gz > "$dump"
  # The portable bundle contains schema, checksums and data, without source-host owners/ACLs.
  psql -X -v ON_ERROR_STOP=1 --single-transaction --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto; SET ROLE arena_migrator;' -f "$dump" \
    -c "UPDATE public.submission_sources SET storage_path = '/app/storage/submissions/' || digest || '.zip'; UPDATE public.replay_objects SET storage_path = '/app/storage/replays/' || digest || '.oantuti';"
else
  psql -X -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;
SET ROLE arena_migrator;
CREATE TABLE migration_checksums (
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
SQL
  for migration in /opt/arena-migrations/*.sql; do
    version=${migration##*/}; version=${version%%-*}
    checksum=$(sha256sum "$migration" | cut -d ' ' -f 1)
    script=$(mktemp)
    trap 'rm -f "$script"' EXIT HUP INT TERM
    {
      printf 'BEGIN; SET ROLE arena_migrator;\n'
      cat "$migration"
      printf "\nINSERT INTO migration_checksums(version, checksum) VALUES (%s, '%s');\nCOMMIT;\n" "$version" "$checksum"
    } > "$script"
    psql -X -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f "$script"
    rm -f "$script"
  done
fi

psql -X -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
BEGIN;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO arena_app;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM arena_app;
SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO arena_app', tablename)
FROM pg_tables WHERE schemaname = 'public'
  AND tablename NOT IN ('schema_migrations', 'migration_checksums', 'audit_events', 'backup_identity', 'backup_checkpoints') \gexec
GRANT SELECT ON schema_migrations, migration_checksums, backup_identity, backup_checkpoints TO arena_app;
GRANT SELECT, INSERT ON audit_events TO arena_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO arena_app;
COMMIT;
SQL
# The official image invokes init scripts before its final server starts.
touch "$PGDATA/.arena-initialized"
