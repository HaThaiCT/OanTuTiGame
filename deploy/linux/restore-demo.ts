#!/usr/bin/env -S node --import tsx
import { execFileSync } from 'node:child_process';
import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { assertPrivateObjectRoot } from '../../packages/server/src/persistence/private-root.js';

const rootDir = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const nonemptyQuery = `SELECT count(*) FROM (
  SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
  UNION ALL
  SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  UNION ALL
  SELECT oid FROM pg_namespace WHERE nspname NOT IN ('public', 'pg_catalog', 'information_schema')
    AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%'
) objects`;

/** The published dump is data, not a cluster-role or client-version configuration. */
export function portableDemoSql(sql: string): string {
  let copying = false;
  return sql.split('\n').filter(line => {
    if (copying) {
      if (line === '\\.') copying = false;
      return true;
    }
    if (/^COPY .* FROM stdin;$/.test(line)) copying = true;
    return !/^(?:ALTER .* OWNER TO |GRANT |REVOKE |ALTER DEFAULT PRIVILEGES |DROP EXTENSION |COMMENT ON EXTENSION |\\(?:un)?restrict\b)/.test(line);
  }).join('\n');
}

export async function restoreDemo(options: {
  cwd?: string;
  demoDataDir?: string;
  env?: NodeJS.ProcessEnv;
  args?: readonly string[];
} = {}): Promise<void> {
  const env = { ...(options.env ?? process.env) };
  if (env.PGPASSWORD_FILE) {
    const secret = lstatSync(env.PGPASSWORD_FILE);
    if (!secret.isFile() || secret.isSymbolicLink() || (secret.mode & 0o077) !== 0) throw new Error('PGPASSWORD_FILE must be a private regular file');
    env.PGPASSWORD = readFileSync(env.PGPASSWORD_FILE, 'utf8').replace(/\r?\n$/, '');
  }
  const args = options.args ?? process.argv.slice(2);
  if (args.length !== 1 || args[0] !== '--fresh-empty-database') {
    throw new Error('Usage: npm run demo:restore -- --fresh-empty-database (explicit PGHOST, PGPORT, PGUSER, PGDATABASE required; create an empty database first)');
  }
  for (const name of ['PGHOST', 'PGPORT', 'PGUSER', 'PGDATABASE']) {
    if (!env[name]?.trim()) throw new Error(`Set ${name} explicitly; restore never selects a default database`);
  }
  const cwd = resolve(options.cwd ?? process.cwd());
  const demoDataDir = options.demoDataDir ?? join(rootDir, 'deploy/demo-data');
  const sqlGzPath = join(demoDataDir, 'arena_demo.sql.gz');
  const objectsTarPath = join(demoDataDir, 'arena_objects.tar.gz');
  if (!existsSync(sqlGzPath) || !existsSync(objectsTarPath)) throw new Error('Both bundled demo SQL and object archives are required');
  const psql = env.PSQL_BIN || 'psql';
  const connection = ['--no-psqlrc', '--no-password', '--host', env.PGHOST!, '--port', env.PGPORT!, '--username', env.PGUSER!, '--dbname', env.PGDATABASE!, '--set', 'ON_ERROR_STOP=1'];
  const count = execFileSync(psql, [...connection, '--tuples-only', '--no-align', '--command', nonemptyQuery], { env, encoding: 'utf8' }).trim();
  if (count !== '0') throw new Error('Target database is not empty; demo restore refuses to overwrite existing data');

  const sources = resolve(cwd, env.OANTUTI_SUBMISSION_DIR || 'storage/submissions');
  const replays = resolve(cwd, env.OANTUTI_REPLAYS_DIR || 'storage/replays');
  if (sources === replays) throw new Error('Submission and replay roots must be separate directories');
  assertPrivateObjectRoot(sources, 'Submission source root', { ownedByConvention: !env.OANTUTI_SUBMISSION_DIR });
  assertPrivateObjectRoot(replays, 'Replay object root', { ownedByConvention: !env.OANTUTI_REPLAYS_DIR });
  if (readdirSync(sources).length !== 0 || readdirSync(replays).length !== 0) {
    throw new Error('Submission and replay object roots must be empty; restore never merges existing evidence');
  }
  const archiveNames = execFileSync('tar', ['-tzf', objectsTarPath], { env, encoding: 'utf8' }).trim().split('\n');
  const archiveMetadata = execFileSync('tar', ['-tvzf', objectsTarPath, '--numeric-owner'], { env, encoding: 'utf8' }).trim().split('\n');
  if (archiveMetadata.some(line => line[0] !== '-' && line[0] !== 'd') || archiveNames.some(name =>
    !/^(?:\.\/)?(?:storage\/?|storage\/replays\/?|storage\/submissions\/?|storage\/replays\/[a-f0-9]+\.oantuti|storage\/submissions\/[a-f0-9]+\.zip)$/.test(name) && name !== './'
  )) {
    throw new Error('Invalid demo archive: only regular evidence files and their directories are allowed');
  }
  const temporary = mkdtempSync(join(tmpdir(), 'arena-demo-restore-'));
  const installed: string[] = [];
  try {
    const extracted = join(temporary, 'objects');
    mkdirSync(extracted, { mode: 0o700 });
    // Only the two evidence subtrees are accepted. Extract into a private staging directory,
    // never over the checkout or operator-owned roots; copy regular files exclusively below.
    execFileSync('tar', ['-xzf', objectsTarPath, '--no-same-owner', '--no-same-permissions', '-C', extracted, 'storage/replays', 'storage/submissions'], { env, stdio: 'pipe' });
    for (const [name, target, suffix] of [['replays', replays, '.oantuti'], ['submissions', sources, '.zip']]) {
      const directory = join(extracted, 'storage', name);
      if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('Invalid demo object directory');
      for (const file of readdirSync(directory)) {
        if (!/^[a-f0-9]+\.(?:zip|oantuti)$/.test(file) || !file.endsWith(suffix) || !lstatSync(join(directory, file)).isFile() || lstatSync(join(directory, file)).isSymbolicLink()) {
          throw new Error('Invalid demo evidence object');
        }
        copyFileSync(join(directory, file), join(target, file), constants.COPYFILE_EXCL);
        installed.push(join(target, file));
        chmodSync(join(target, file), 0o600);
      }
    }
    const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const sql = portableDemoSql(gunzipSync(readFileSync(sqlGzPath)).toString('utf8'));
    const restorePath = join(temporary, 'restore.sql');
    writeFileSync(restorePath, `DO $guard$ BEGIN IF (${nonemptyQuery}) <> 0 THEN RAISE EXCEPTION 'Target database is not empty'; END IF; END $guard$;\n${sql}\nSET standard_conforming_strings = on;\nUPDATE public.submission_sources SET storage_path = ${literal(sources + '/')} || regexp_replace(storage_path, '^.*/', '');\nUPDATE public.replay_objects SET storage_path = ${literal(replays + '/')} || digest || '.oantuti';\n`, { mode: 0o600 });
    execFileSync(psql, [...connection, '--single-transaction', '--file', restorePath], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (error) {
    // The roots were empty and COPYFILE_EXCL guarantees these are only our files.
    // PostgreSQL rolls back its single transaction; remove our bytes so retry is possible.
    for (const file of installed) rmSync(file, { force: true });
    throw error;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  console.log('Demo restored successfully. Use the same OANTUTI_SUBMISSION_DIR and OANTUTI_REPLAYS_DIR when starting the server.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  restoreDemo().catch(() => {
    // psql diagnostics can contain credential-bearing COPY rows. Fail closed without dumping them.
    console.error('Demo restore failed. Check explicit database settings, an empty target, private object roots, and PostgreSQL client availability.');
    process.exitCode = 1;
  });
}
