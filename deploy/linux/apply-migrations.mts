#!/usr/bin/env node
/**
 * Migrations 017 and 018 did not self-register; their probes support safe backfilling while all
 * migration file contents are tracked by SHA-256 checksums in migration_checksums.
 *
 * The applier holds a database-scoped session advisory lock for the full status/apply operation.
 * A legacy schema without checksums requires an explicit --baseline operator attestation.
 *
 * Safety guards:
 *  - an isolated test database (`arena_*test*`, the same rule `test-isolated.mts` enforces) runs
 *    without further ceremony;
 *  - any other database requires `OANTUTI_MIGRATE_CONFIRM` to equal its exact name, so a demo,
 *    staging or production database can never be migrated by accident or by a stale shell.
 *
 * Usage:
 *   deploy/linux/apply-migrations.mts --status                    # report state, change nothing
 *   deploy/linux/apply-migrations.mts --apply                     # apply pending migrations
 *   OANTUTI_MIGRATE_CONFIRM=arena_rebuild_c72cd5a74f33 \
 *     deploy/linux/apply-migrations.mts --apply --grant-to arena_rebuild_app
 *
 * `--grant-to ROLE` re-asserts the application DML grant that init-postgres.sh applies to a fresh
 * volume, which a database migrated after initialisation would otherwise miss for new tables.
 *
 * A database with no schema_migrations table is a fresh deployment: apply runs all migrations from
 * 001 and records checksums. Existing schemas without checksums require --apply --baseline.
 *
 * Environment: standard PGHOST/PGPORT/PGUSER/PGDATABASE (see db.ts resolveDbConfig). Over TCP the
 * password comes from PGPASSWORD_FILE; a bare PGPASSWORD environment value is refused.
 */
import { createHash } from 'node:crypto';
import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PostgresDatabase, resolveDbConfig } from '../../packages/server/src/persistence/db.js';
import { quotePostgresRole } from '../../packages/server/src/persistence/postgres-role-identifier.js';

const verdict = process.argv.includes('--apply') ? 'apply' : process.argv.includes('--status') ? 'status' : undefined;
if (!verdict) throw new Error('Usage: apply-migrations.mts --status | --apply');

if (process.env.PGPASSWORD) throw new Error('Password environment is forbidden; use PGPASSWORD_FILE');
if (!process.env.PGHOST?.startsWith('/') && !process.env.PGPASSWORD_FILE) {
  throw new Error('TCP connections require PGPASSWORD_FILE');
}
const passwordFile = process.env.PGPASSWORD_FILE;
if (passwordFile !== undefined) {
  const secret = readFileSync(passwordFile, 'utf8').trim();
  if (!secret) throw new Error('PGPASSWORD_FILE must not be empty');
  process.env.PGPASSWORD = secret;
}

const config = resolveDbConfig();
const database = process.env.PGDATABASE;
if (!database || database !== config.database) {
  throw new Error('PGDATABASE must be set and match the resolved database configuration');
}
const isolated = /^arena_[a-z0-9_]*test[a-z0-9_]*$/.test(database);
if (!isolated) {
  const confirmation = process.env.OANTUTI_MIGRATE_CONFIRM;
  if (confirmation !== database) {
    throw new Error(
      `Refusing to migrate non-isolated database ${database}: set OANTUTI_MIGRATE_CONFIRM=${database} after an explicit operator decision`
    );
  }
  process.stdout.write(`!! migrating non-isolated database ${database} (explicitly confirmed)\n`);
}

const db = new PostgresDatabase(config);
const lockClient = new pg.Client(config);
let lockAcquired = false;
try {
  await lockClient.connect();
  await lockClient.query("SELECT pg_advisory_lock(hashtextextended(current_database() || ':oantuti-migrations', 0))");
  lockAcquired = true;
const migrationsDir = process.env.OANTUTI_MIGRATIONS_DIR ?? 'packages/server/src/persistence/migrations';
const lockedQuery = db.query.bind(db);
const name = (await lockedQuery<{ name: string }>('SELECT current_database() AS name')).rows[0]?.name;
if (name !== database) throw new Error('Connected database does not match PGDATABASE');
const files = readdirSync(migrationsDir).filter((file) => /^\d{3}-.*\.sql$/.test(file)).sort();
const contents = new Map(files.map((file) => [file, readFileSync(join(migrationsDir, file), 'utf8')]));
const checksums = new Map([...contents].map(([file, sql]) => [Number.parseInt(file.slice(0, 3), 10), createHash('sha256').update(sql).digest('hex')]));
if (process.argv.includes('--grant-to')) {
  const grantIndex = process.argv.indexOf('--grant-to');
  const grantee = process.argv[grantIndex + 1];
  if (!grantee || grantee.startsWith('--')) throw new Error('--grant-to requires a role name');
  quotePostgresRole(grantee);
  const exists = (await lockedQuery<{ ok: boolean }>('SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS ok', [grantee])).rows[0]?.ok;
  if (exists !== true) throw new Error(`role ${grantee} does not exist on this cluster`);
}

const migrationRole = process.env.OANTUTI_MIGRATION_ROLE;
if (migrationRole) {
  quotePostgresRole(migrationRole);
  const exists = (await lockedQuery<{ ok: boolean }>('SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=$1) AS ok', [migrationRole])).rows[0]?.ok;
  if (!exists) throw new Error(`Migration role ${migrationRole} does not exist`);
}

const tracking = await lockedQuery<{ present: string | null }>("SELECT to_regclass('public.schema_migrations')::text AS present");
const freshDatabase = tracking.rows[0]?.present === null;
const checksumTable = await lockedQuery<{ present: string | null }>("SELECT to_regclass('public.migration_checksums')::text AS present");
let needsBaseline = !freshDatabase && checksumTable.rows[0]?.present === null;
if (checksumTable.rows[0]?.present !== null && !needsBaseline) {
  const applied = (await lockedQuery<{ version: number; checksum: string }>('SELECT version, checksum FROM migration_checksums')).rows;
  const registeredVersions = freshDatabase ? [] : (await lockedQuery<{ version: number }>('SELECT version FROM schema_migrations')).rows.map((row) => row.version);
  const known = new Set(checksums.keys());
  for (const row of applied) {
    if (!known.has(row.version)) throw new Error(`Unknown applied migration version ${row.version}; refusing to continue`);
    if (checksums.get(row.version) !== row.checksum) throw new Error(`Migration checksum drift for version ${row.version}; refusing to continue`);
  }
  for (const version of registeredVersions) {
    if (!known.has(version)) throw new Error(`Unknown applied migration version ${version}; refusing to continue`);
    if (!applied.some((row) => row.version === version)) needsBaseline = true;
  }
}

/** Versions whose DDL was never self-registered, with the schema probe that proves it landed. */
const PROBES: Record<number, { describe: string; check: () => Promise<boolean> }> = {
  17: {
    describe: "encounters_status_check allows 'WALKOVER'",
    check: async () =>
      (await lockedQuery<{ ok: boolean }>(
        // `to_regclass` keeps the probe meaningful on a fresh database, where the table does not exist yet.
        "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public.encounters') AND conname = 'encounters_status_check' AND pg_get_constraintdef(oid) LIKE '%WALKOVER%') AS ok"
      )).rows[0]?.ok === true,
  },
  18: {
    describe: 'tournament_rounds.slot_count exists',
    check: async () =>
      (await lockedQuery<{ ok: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tournament_rounds' AND column_name = 'slot_count') AS ok"
      )).rows[0]?.ok === true,
  },
};

const registered = freshDatabase
  ? new Set<number>()
  : new Set((await lockedQuery<{ version: number }>('SELECT version FROM schema_migrations')).rows.map((row) => row.version));

if (freshDatabase) {
  process.stdout.write(`fresh database ${database}: applying every migration from 001\n`);
}

const report: Array<{ version: number; file: string; state: string }> = [];
for (const file of files) {
  const version = Number.parseInt(file.slice(0, 3), 10);
  if (registered.has(version)) {
    report.push({ version, file, state: 'registered' });
    continue;
  }
  const probe = PROBES[version];
  if (probe && (await probe.check())) {
    report.push({ version, file, state: `applied but unregistered (${probe.describe})` });
    continue;
  }
  report.push({ version, file, state: probe ? `MISSING (probe: ${probe.describe} is false)` : 'MISSING' });
}

if (!freshDatabase && checksumTable.rows[0]?.present !== null) {
  for (const entry of report.filter((item) => item.state.startsWith('applied but unregistered'))) {
    const version = await lockedQuery<{ present: boolean }>('SELECT EXISTS (SELECT 1 FROM migration_checksums WHERE version = $1) AS present', [entry.version]);
    if (!version.rows[0]?.present) needsBaseline = true;
  }
}
if (needsBaseline && !process.argv.includes('--baseline') && verdict === 'apply') throw new Error('BASELINE REQUIRED: legacy database has missing migration checksums; use --baseline only after reviewing the existing schema and migration history');
if (process.argv.includes('--baseline') && !needsBaseline) throw new Error('Cannot baseline: no missing migration checksums');
const pending = report.filter((entry) => entry.state.startsWith('MISSING'));
if (process.argv.includes('--baseline') && pending.length > 0) throw new Error('Cannot baseline while migrations are pending; baseline the existing schema first, then apply normally');
const unregistered = report.filter((entry) => entry.state.startsWith('applied but unregistered'));

if (verdict === 'status') {
  for (const entry of report) process.stdout.write(`${String(entry.version).padStart(3, '0')}  ${entry.state.padEnd(58)} ${entry.file}\n`);
  process.stdout.write(`\n${report.length} migrations, ${pending.length} pending, ${unregistered.length} applied-but-unregistered${needsBaseline ? ', BASELINE REQUIRED' : ''}\n`);
  process.exitCode = pending.length === 0 && !needsBaseline ? 0 : 2;
} else {
  if (process.argv.includes('--baseline')) {
    if (process.env.OANTUTI_MIGRATE_CONFIRM !== database) throw new Error(`--baseline requires OANTUTI_MIGRATE_CONFIRM=${database}`);
    const appliedVersions = (await lockedQuery<{ version: number }>('SELECT version FROM schema_migrations')).rows.map((row) => row.version);
    const knownVersions = new Set(checksums.keys());
    for (const version of appliedVersions) if (!knownVersions.has(version)) throw new Error(`Unknown applied migration version ${version}; cannot baseline`);
    await db.withTransaction(async (client) => {
      await client.query('CREATE TABLE IF NOT EXISTS migration_checksums (version integer PRIMARY KEY, checksum text NOT NULL CHECK (checksum ~ \'^[0-9a-f]{64}$\'), recorded_at timestamptz NOT NULL DEFAULT clock_timestamp())');
      for (const version of appliedVersions) await client.query('INSERT INTO migration_checksums(version, checksum) VALUES ($1,$2) ON CONFLICT (version) DO NOTHING', [version, checksums.get(version)]);
    });
    process.stdout.write(`baselined missing checksums for ${appliedVersions.length} registered migrations\n`);
  } else if (freshDatabase) {
    await lockedQuery('CREATE TABLE IF NOT EXISTS migration_checksums (version integer PRIMARY KEY, checksum text NOT NULL CHECK (checksum ~ \'^[0-9a-f]{64}$\'), recorded_at timestamptz NOT NULL DEFAULT clock_timestamp())');
  }
  for (const entry of unregistered) {
    await db.withTransaction(async (client) => {
      await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING', [entry.version, entry.file.replace(/\.sql$/, '')]);
      await client.query('INSERT INTO migration_checksums(version, checksum) VALUES ($1,$2) ON CONFLICT (version) DO NOTHING', [entry.version, checksums.get(entry.version)]);
    });
    process.stdout.write(`backfilled version ${entry.version} (${entry.file})\n`);
  }
  for (const entry of pending) {
    const sql = contents.get(entry.file)!;
    await db.withTransaction(async (client) => {
      if (migrationRole) await client.query(`SET LOCAL ROLE ${quotePostgresRole(migrationRole)}`);
      await client.query(sql);
      const present = await client.query<{ present: string | null }>("SELECT to_regclass('public.schema_migrations')::text AS present");
      if (present.rows[0]?.present !== null) await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING', [entry.version, entry.file.replace(/\.sql$/, '')]);
      await client.query('RESET ROLE');
      await client.query('INSERT INTO migration_checksums(version, checksum) VALUES ($1,$2) ON CONFLICT (version) DO NOTHING', [entry.version, checksums.get(entry.version)]);
    });
    process.stdout.write(`applied ${entry.file}\n`);
  }
  process.stdout.write(`schema_migrations max = ${(await lockedQuery<{ max: number }>('SELECT max(version) AS max FROM schema_migrations')).rows[0]?.max}\n`);
  const grantee = process.argv[process.argv.indexOf('--grant-to') + 1];
  if (process.argv.includes('--grant-to')) {
    const identifier = quotePostgresRole(grantee);
    await db.withTransaction(async (client) => {
      await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${identifier}`);
      const tables = await client.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('schema_migrations','migration_checksums','audit_events','backup_identity','backup_checkpoints')`);
      for (const table of tables.rows) await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "${table.tablename.replaceAll('"', '""')}" TO ${identifier}`);
      await client.query(`GRANT SELECT ON schema_migrations, migration_checksums, backup_identity, backup_checkpoints TO ${identifier}`);
      await client.query(`GRANT SELECT, INSERT ON audit_events TO ${identifier}`);
      await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${identifier}`);
    });
  }
  process.stdout.write('Migration apply complete.\n');
}

} finally {
  try {
    if (lockAcquired) await lockClient.query("SELECT pg_advisory_unlock(hashtextextended(current_database() || ':oantuti-migrations', 0))");
  } finally {
    await lockClient.end();
    await db.close();
  }
}
