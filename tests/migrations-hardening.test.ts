import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

const connectionString = process.env.OANTUTI_MIGRATION_TEST_URL;
const suite = connectionString ? describe : describe.skip;
const root = process.cwd();
const migrationDir = join(root, 'packages/server/src/persistence/migrations');
const cli = join(root, 'deploy/linux/apply-migrations.mts');
const admin = connectionString ? new pg.Client({ connectionString }) : undefined;
const databases: string[] = [];
const migrationRole = `arena_migrator_test_${process.pid}`;
const grantRole = `migration_grant_test_${process.pid}`;
let connection: URL;
let passwordDirectory: string;
function databaseConnection(database: string): string {
  const target = new URL(connectionString!);
  target.pathname = `/${database}`;
  return target.toString();
}
let migrationFixture: string;
async function createDatabase() {
  const name = `arena_migration_test_${process.pid}_${databases.length}_${Date.now()}`;
  await admin!.query(`CREATE DATABASE "${name}"`);
  databases.push(name);
  return name;
}
async function invoke(database: string, args: string[], migrationRole = '') {
  const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args], { cwd: root, env: { ...process.env,
    PGHOST: connection.hostname, PGPORT: connection.port || '5432', PGUSER: decodeURIComponent(connection.username),
    PGDATABASE: database, PGPASSWORD: undefined, PGPASSWORD_FILE: join(passwordDirectory, 'password'),
    OANTUTI_MIGRATE_CONFIRM: database, OANTUTI_MIGRATION_ROLE: migrationRole, OANTUTI_MIGRATIONS_DIR: migrationFixture,
  } });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  return { code, output };
}
suite('migration hardening against isolated PostgreSQL', () => {
  beforeAll(async () => {
    connection = new URL(connectionString!);
    if (connection.pathname !== '/postgres') throw new Error('OANTUTI_MIGRATION_TEST_URL must connect to the isolated cluster admin database /postgres');
    passwordDirectory = mkdtempSync(join(tmpdir(), 'migration-test-'));
    migrationFixture = mkdtempSync(join(tmpdir(), 'migration-fixture-'));
    cpSync(migrationDir, migrationFixture, { recursive: true });
    writeFileSync(join(passwordDirectory, 'password'), decodeURIComponent(connection.password));
    chmodSync(join(passwordDirectory, 'password'), 0o600);
    await admin!.connect();
    await admin!.query(`CREATE ROLE "${migrationRole}" NOLOGIN`);
  });
  afterAll(async () => {
    for (const database of databases.reverse()) await admin!.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin!.query(`DROP ROLE IF EXISTS "${grantRole}"`);
    await admin!.end();
    rmSync(migrationFixture, { recursive: true, force: true });
    rmSync(passwordDirectory, { recursive: true, force: true });
  });
  it('requires baseline for legacy tracking and status is read-only', async () => {
    const database = await createDatabase();
    const client = new pg.Client({ connectionString: databaseConnection(database) }); await client.connect();
    await client.query('CREATE TABLE schema_migrations (version integer primary key, name text not null, applied_at timestamptz default now())');
    await client.query("INSERT INTO schema_migrations(version,name) VALUES (1,'001-control-plane')"); await client.end();
    const status = await invoke(database, ['--status']); expect(status.output).toContain('BASELINE REQUIRED');
    const result = await invoke(database, ['--apply']); expect(result.code).not.toBe(0);
    const check = new pg.Client({ connectionString: databaseConnection(database) }); await check.connect();
    expect((await check.query("SELECT to_regclass('public.migration_checksums') AS name")).rows[0].name).toBeNull(); await check.end();
  });
  it('does not combine legacy baseline with applying pending migrations', async () => {
    const database = await createDatabase();
    const client = new pg.Client({ connectionString: databaseConnection(database) }); await client.connect();
    await client.query('CREATE TABLE schema_migrations (version integer primary key, name text not null, applied_at timestamptz default now())');
    await client.query("INSERT INTO schema_migrations(version,name) VALUES (1,'001-control-plane')");
    await client.end();
    const result = await invoke(database, ['--apply', '--baseline']);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('migrations are pending');
    const check = new pg.Client({ connectionString: databaseConnection(database) }); await check.connect();
    expect((await check.query("SELECT to_regclass('public.courses') AS name")).rows[0].name).toBeNull();
    await check.end();
  });
  it('baselines a legacy schema only after explicit confirmation, then reports clean status', async () => {
    const database = await createDatabase();
    expect((await invoke(database, ['--apply'])).code).toBe(0);
    const client = new pg.Client({ connectionString: databaseConnection(database) }); await client.connect();
    await client.query('DROP TABLE migration_checksums'); await client.end();
    const status = await invoke(database, ['--status']); expect(status.output).toContain('BASELINE REQUIRED');
    expect((await invoke(database, ['--apply', '--baseline'])).code).toBe(0);
    const recovered = await invoke(database, ['--status']); expect(recovered.code).toBe(0);
  });
  it('reports missing rows in a partial checksum ledger and baselines only after confirmation', async () => {
    const database = await createDatabase();
    expect((await invoke(database, ['--apply'])).code).toBe(0);
    const client = new pg.Client({ connectionString: databaseConnection(database) }); await client.connect();
    await client.query('DELETE FROM migration_checksums WHERE version = 26'); await client.end();
    expect((await invoke(database, ['--status'])).output).toContain('BASELINE REQUIRED');
    expect((await invoke(database, ['--apply'])).code).not.toBe(0);
    expect((await invoke(database, ['--apply', '--baseline'])).code).toBe(0);
    expect((await invoke(database, ['--status'])).code).toBe(0);
  });
  it('refuses an unnecessary checksum baseline when no records are missing', async () => {
    const database = await createDatabase();
    expect((await invoke(database, ['--apply'])).code).toBe(0);
    const result = await invoke(database, ['--apply', '--baseline']);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('no missing migration checksums');
    expect((await invoke(database, ['--status'])).code).toBe(0);
  });
  it('applies fresh schema when DDL runs under a separate migration role', async () => {
    const database = await createDatabase();
    const client = new pg.Client({ connectionString: databaseConnection(database) }); await client.connect();
    await client.query('CREATE EXTENSION pgcrypto');
    await client.query(`GRANT CREATE ON DATABASE "${database}" TO "${migrationRole}"`);
    await client.query(`GRANT USAGE, CREATE ON SCHEMA public TO "${migrationRole}"`);
    await client.end();
    const result = await invoke(database, ['--apply'], migrationRole);
    expect(result.code, result.output).toBe(0);
    const check = new pg.Client({ connectionString: databaseConnection(database) }); await check.connect();
    try {
      expect(Number((await check.query('SELECT max(version) AS version FROM schema_migrations')).rows[0].version)).toBe(26);
      expect(Number((await check.query('SELECT count(*) AS count FROM migration_checksums')).rows[0].count)).toBe(26);
    } finally { await check.end(); }
  });
  it('refuses changed applied bytes before migration DDL', async () => {
    const database = await createDatabase();
    const applied = await invoke(database, ['--apply']); expect(applied.code).toBe(0);
    const migration = join(migrationFixture, '026-backup-integrity.sql');
    const original = readFileSync(migration, 'utf8');
    try {
      writeFileSync(migration, `${original}\nCREATE TABLE migration_drift_sentinel (id integer);\n`);
      const changed = await invoke(database, ['--apply']); expect(changed.code).not.toBe(0); expect(changed.output).toMatch(/checksum|drift/i);
      const verify = new pg.Client({ connectionString: databaseConnection(database) }); await verify.connect();
      expect((await verify.query("SELECT to_regclass('public.migration_drift_sentinel') AS name")).rows[0].name).toBeNull(); await verify.end();
    } finally { writeFileSync(migration, original); }
  });
  it('rolls back migration DDL, schema version, and checksum together on SQL error', async () => {
    const database = await createDatabase();
    const migration = join(migrationFixture, '026-backup-integrity.sql');
    const original = readFileSync(migration, 'utf8');
    try {
      writeFileSync(migration, `${original}\nCREATE TABLE migration_failure_sentinel (id integer);\nSELECT migration_intentional_failure();\n`);
      const failed = await invoke(database, ['--apply']);
      expect(failed.code).not.toBe(0);
      const inspect = new pg.Client({ connectionString: databaseConnection(database) }); await inspect.connect();
      expect((await inspect.query("SELECT to_regclass('public.migration_failure_sentinel') AS name")).rows[0].name).toBeNull();
      expect((await inspect.query('SELECT version FROM schema_migrations WHERE version = 26')).rows).toHaveLength(0);
      expect((await inspect.query('SELECT version FROM migration_checksums WHERE version = 26')).rows).toHaveLength(0);
      await inspect.end();
    } finally { writeFileSync(migration, original); }
  });
  it('rolls back every grant change when one grant statement fails', async () => {
    const database = await createDatabase();
    const applied = await invoke(database, ['--apply']); expect(applied.code).toBe(0);
    const client = new pg.Client({ connectionString: databaseConnection(database) }); await client.connect();
    await client.query(`CREATE ROLE "${grantRole}" NOLOGIN`);
    await client.query(`GRANT UPDATE ON TABLE schema_migrations TO "${grantRole}"`);
    await client.query('DROP TABLE audit_events');
    await client.end();
    const failed = await invoke(database, ['--apply', '--grant-to', grantRole]); expect(failed.code).not.toBe(0);
    const inspect = new pg.Client({ connectionString: databaseConnection(database) }); await inspect.connect();
    expect((await inspect.query('SELECT has_table_privilege($1,\'schema_migrations\',\'UPDATE\') AS update', [grantRole])).rows[0].update).toBe(true);
    await inspect.end();
  });
  it('serializes simultaneous appliers on an empty database', async () => {
    const database = await createDatabase();
    const outcomes = await Promise.all([invoke(database, ['--apply']), invoke(database, ['--apply'])]);
    expect(outcomes.map((result) => result.code).sort()).toEqual([0, 0]);
  });
});
