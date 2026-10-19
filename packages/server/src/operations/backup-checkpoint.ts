import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readSync, writeSync, fsyncSync, mkdirSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type pg from 'pg';
import type { PostgresDatabase, DbConfig } from '../persistence/db.js';

export const BACKUP_BARRIER = '1868657748, 26';
const MAX_FILE = 4 * 1024 * 1024 * 1024;
const MAX_MANIFEST = 16 * 1024 * 1024;
export interface BackupObject { readonly path: string; readonly bytes: number; readonly sha256: string }
export interface BackupManifest {
  readonly version: 1;
  readonly deploymentId: string;
  readonly generation: number;
  readonly checkpointAt: string;
  readonly database: { readonly name: string; readonly snapshot: string; readonly restoreLsn: string; readonly file: BackupObject };
  readonly objects: readonly BackupObject[];
  readonly restoreContract: 'logical-snapshot-requeue-new-generation-v1';
}
export interface VerifiedBackupCheckpoint {
  readonly manifestDigest: string;
  readonly checkpointAt: string;
  readonly verificationAt: string;
  readonly deploymentId: string;
  readonly generation: number;
}
const verified = new WeakMap<object, BackupManifest>();

/** Roots and every descendant are private, owned by this operator, and never symlinks. */
export function privateRoot(root: string): string {
  if (!path.isAbsolute(root)) throw new Error('Backup roots must be absolute');
  const resolved = path.resolve(root);
  for (let current = resolved; ; current = path.dirname(current)) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe directory: ${current}`);
    if (current === resolved && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) throw new Error(`Root must be private and operator-owned: ${current}`);
    if (current === path.dirname(current)) break;
  }
  return realpathSync(resolved);
}
function fileAt(root: string, relative: string): string {
  if (!relative || relative.includes('\\') || relative.split('/').some((p) => !p || p === '.' || p === '..') || path.isAbsolute(relative)) throw new Error('Unsafe manifest path');
  const target = path.join(root, relative);
  for (let parent = path.dirname(target); parent !== root; parent = path.dirname(parent)) {
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error('Unsafe inventory directory');
  }
  return target;
}
function readBounded(root: string, relative: string, max: number): Buffer {
  const fd = openSync(fileAt(root, relative), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > max || stat.size < 0 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error('Backup file must be private, bounded, regular and operator-owned');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) { const n = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) throw new Error('Truncated backup file'); offset += n; }
    const after = fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('Backup file changed during read');
    return bytes;
  } finally { closeSync(fd); }
}
function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function writePrivate(root: string, relative: string, bytes: Buffer): BackupObject {
  const target = fileAt(root, relative);
  const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { let offset = 0; while (offset < bytes.length) offset += writeSync(fd, bytes, offset); fsyncSync(fd); } finally { closeSync(fd); }
  const directory = openSync(path.dirname(target), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(directory); } finally { closeSync(directory); }
  return { path: relative, bytes: bytes.length, sha256: digest(bytes) };
}
/** Hash/copy bounded regular files with constant memory, including multi-gigabyte database dumps. */
function processFile(root: string, relative: string, destination?: { root: string; relative: string }): BackupObject {
  const fd = openSync(fileAt(root, relative), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let target: number | undefined;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error('Unsafe or oversized inventory file');
    if (destination) target = openSync(fileAt(destination.root, destination.relative), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < stat.size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
      if (!count) throw new Error('Truncated inventory file');
      hash.update(buffer.subarray(0, count));
      if (target !== undefined) { let written = 0; while (written < count) written += writeSync(target, buffer, written, count - written); }
      offset += count;
    }
    const after = fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('Inventory changed during capture');
    if (target !== undefined) fsyncSync(target);
    if (destination) {
      const directory = openSync(path.dirname(fileAt(destination.root, destination.relative)), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
    return { path: destination?.relative ?? relative, bytes: stat.size, sha256: hash.digest('hex') };
  } finally { closeSync(fd); if (target !== undefined) closeSync(target); }
}
function inventory(root: string, prefix = ''): string[] {
  return readdirSync(path.join(root, prefix)).sort().flatMap((name) => {
    const relative = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(fileAt(root, relative));
    if (stat.isDirectory() && !stat.isSymbolicLink()) return inventory(root, relative);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Nonregular object in inventory');
    return [relative];
  });
}
async function dump(config: DbConfig, snapshot: string, destination: string): Promise<void> {
  const fd = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--exclude-table-data=public.backup_checkpoints', '--lock-wait-timeout=30000', `--snapshot=${snapshot}`, '--host', config.host, '--port', String(config.port), '--username', config.user, '--dbname', config.database, '--no-password'], { stdio: ['ignore', fd, 'inherit'] });
      child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`pg_dump failed (${code})`)));
    });
    fsyncSync(fd);
  } finally { closeSync(fd); }
}
/** Holds the same exclusive transaction lock as inventory GC and all protected DB mutations. */
export async function produceCheckpoint(db: PostgresDatabase, config: DbConfig, destination: string, roots: Readonly<Record<string, string>>): Promise<string> {
  const output = privateRoot(destination);
  if (readdirSync(output).length) throw new Error('Checkpoint destination must be empty');
  if (Object.keys(roots).sort().join(',') !== 'compiled,completions,replays,sources') throw new Error('Exact sources/replays/compiled/completions roots required');
  const sources = Object.entries(roots).map(([name, root]) => {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('Invalid object root name');
    const source = privateRoot(root);
    if (output === source || output.startsWith(source + '/') || source.startsWith(output + '/')) throw new Error('Checkpoint and source roots must be disjoint');
    return [name, source] as const;
  });
  return db.withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(${BACKUP_BARRIER})`);
    const identity = await client.query<{ deployment_id: string; generation: number }>('SELECT deployment_id, generation FROM backup_identity WHERE singleton');
    if (!identity.rows[0]) throw new Error('Missing backup identity');
    const checkpointAt = new Date().toISOString();
    const point = await client.query<{ snapshot: string; lsn: string }>('SELECT pg_export_snapshot() AS snapshot, pg_current_wal_flush_lsn()::text AS lsn');
    await dump(config, point.rows[0].snapshot, path.join(output, 'database.dump'));
    const databaseFile = processFile(output, 'database.dump');
    const objects: BackupObject[] = [];
    for (const [name, root] of sources) {
      mkdirSync(path.join(output, name), { mode: 0o700 });
      for (const relative of inventory(root)) {
        mkdirSync(path.dirname(path.join(output, name, relative)), { recursive: true, mode: 0o700 });
        objects.push(processFile(root, relative, { root: output, relative: `${name}/${relative}` }));
      }
    }
    const sourceRoot = sources.find(([name]) => name === 'sources')?.[1];
    const replayRoot = sources.find(([name]) => name === 'replays')?.[1];
    if (!sourceRoot || !replayRoot) throw new Error('sources and replays roots are required');
    const refs = await client.query<{ kind: string; digest: string; storage_path: string }>(
      "SELECT 'sources' AS kind, digest, storage_path FROM submission_sources UNION ALL SELECT 'replays', digest, storage_path FROM replay_objects");
    const objectNames = new Set(objects.map((item) => item.path));
    for (const ref of refs.rows) {
      const root = ref.kind === 'sources' ? sourceRoot : replayRoot;
      const relative = path.relative(root, ref.storage_path);
      if (!/^[a-f0-9]{64}$/.test(ref.digest) || relative.startsWith('..') || path.isAbsolute(relative)
          || !objectNames.has(`${ref.kind}/${relative}`)) throw new Error(`Database object missing from inventory: ${ref.kind}/${ref.digest}`);
    }
    const pending = await client.query<{ evidence_payload: { native?: { capsuleDigest?: string } } }>(
      "SELECT evidence_payload FROM job_completions WHERE state = 'PENDING'");
    for (const completion of pending.rows) {
      if (!completion.evidence_payload?.native) continue; // Dev-only in-process evidence has no capsule.
      const capsule = completion.evidence_payload?.native?.capsuleDigest;
      if (typeof capsule !== 'string' || !/^[a-f0-9]{64}$/.test(capsule)
          || !objectNames.has(`completions/${capsule}.json`)) throw new Error('Pinned completion capsule missing from checkpoint inventory');
    }
    const manifest: BackupManifest = { version: 1, deploymentId: identity.rows[0].deployment_id, generation: identity.rows[0].generation, checkpointAt,
      database: { name: config.database, snapshot: point.rows[0].snapshot, restoreLsn: point.rows[0].lsn, file: databaseFile }, objects,
      restoreContract: 'logical-snapshot-requeue-new-generation-v1' };
    const bytes = Buffer.from(JSON.stringify(manifest));
    if (bytes.length > MAX_MANIFEST) throw new Error('Manifest exceeds bound');
    writePrivate(output, 'manifest.json', bytes);
    const dir = openSync(output, constants.O_RDONLY | constants.O_DIRECTORY); try { fsyncSync(dir); } finally { closeSync(dir); }
    return digest(bytes);
  });
}
/** Verifies bytes at the destination; caller supplies the independently transported expected digest. */
export function verifyCheckpoint(root: string, expectedDigest: string): VerifiedBackupCheckpoint {
  if (!/^[a-f0-9]{64}$/.test(expectedDigest)) throw new Error('Expected SHA-256 required');
  const destination = privateRoot(root);
  const bytes = readBounded(destination, 'manifest.json', MAX_MANIFEST);
  if (digest(bytes) !== expectedDigest) throw new Error('Manifest digest mismatch');
  const manifest = JSON.parse(bytes.toString('utf8')) as BackupManifest;
  if (manifest.version !== 1 || manifest.restoreContract !== 'logical-snapshot-requeue-new-generation-v1'
      || !/^[a-f0-9-]{36}$/.test(manifest.deploymentId) || !Number.isSafeInteger(manifest.generation) || manifest.generation < 1
      || new Date(manifest.checkpointAt).toISOString() !== manifest.checkpointAt || Date.parse(manifest.checkpointAt) > Date.now()
      || !manifest.database.name || !manifest.database.snapshot || !/^[A-Fa-f0-9]+\/[A-Fa-f0-9]+$/.test(manifest.database.restoreLsn)
      || manifest.database.file.path !== 'database.dump' || !Array.isArray(manifest.objects)) throw new Error('Invalid checkpoint manifest');
  const seen = new Set(['manifest.json']);
  for (const item of [manifest.database.file, ...manifest.objects]) {
    if (seen.has(item.path) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > MAX_FILE || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Invalid inventory');
    seen.add(item.path);
    const content = processFile(destination, item.path);
    if (content.bytes !== item.bytes || content.sha256 !== item.sha256) throw new Error(`Object digest mismatch: ${item.path}`);
  }
  const actual = inventory(destination);
  if (actual.length !== seen.size || actual.some((name) => !seen.has(name))) throw new Error('Unmanifested objects present');
  const report = Object.freeze({ manifestDigest: expectedDigest, checkpointAt: manifest.checkpointAt, verificationAt: new Date().toISOString(), deploymentId: manifest.deploymentId, generation: manifest.generation });
  verified.set(report, manifest);
  return report;
}
/** A plain JSON report is never accepted as evidence. Publishing additionally requires a dedicated DB role. */
export async function publishCheckpoint(db: PostgresDatabase, report: VerifiedBackupCheckpoint): Promise<void> {
  const manifest = verified.get(report);
  if (!manifest) throw new Error('Checkpoint must be verified from destination bytes in this process');
  await db.withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(${BACKUP_BARRIER})`);
    const allowed = await client.query<{ allowed: boolean }>(`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolname = 'oantuti_backup_verifier') AS allowed`);
    if (!allowed.rows[0]?.allowed) throw new Error('Publishing requires the dedicated oantuti_backup_verifier database role');
    const binding = await client.query('SELECT 1 FROM backup_identity WHERE singleton AND deployment_id = $1 AND generation = $2', [report.deploymentId, report.generation]);
    if (!binding.rowCount) throw new Error('Checkpoint belongs to another deployment or restored generation');
    await client.query(`INSERT INTO backup_checkpoints (manifest_digest, deployment_id, generation, checkpoint_at, verification_at, database_digest, restore_lsn, object_count)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (manifest_digest) DO NOTHING`, [report.manifestDigest, report.deploymentId, report.generation, report.checkpointAt, report.verificationAt, manifest.database.file.sha256, manifest.database.restoreLsn, manifest.objects.length]);
  });
}

/** Run once on an isolated restored DB, before enabling any API/worker. Old envelopes cannot survive. */
export async function activateRestoredGeneration(client: pg.PoolClient, report: VerifiedBackupCheckpoint, roots: { sources: string; replays: string; compiled: string; completions: string }): Promise<number> {
  const manifest = verified.get(report);
  if (!manifest) throw new Error('Restore activation requires a byte-verified checkpoint');
  const sourceRoot = privateRoot(roots.sources);
  const replayRoot = privateRoot(roots.replays);
  const compiledRoot = privateRoot(roots.compiled);
  const completionsRoot = privateRoot(roots.completions);
  await client.query(`SELECT pg_advisory_xact_lock(${BACKUP_BARRIER})`);
  const identity = await client.query<{ generation: number }>('UPDATE backup_identity SET generation = generation + 1 WHERE singleton AND deployment_id = $1 AND generation = $2 RETURNING generation', [manifest.deploymentId, manifest.generation]);
  if (!identity.rows[0]) throw new Error('Restored identity does not match manifest or was already activated');
  const generation = identity.rows[0].generation;
  // Refuse missing/corrupt restored objects before committing any generation change.
  for (const item of manifest.objects) {
    const [kind, ...parts] = item.path.split('/');
    if (!['sources', 'replays', 'compiled', 'completions'].includes(kind)) throw new Error('Unknown restored object root');
    const restoredRoot = kind === 'sources' ? sourceRoot : kind === 'replays' ? replayRoot : kind === 'compiled' ? compiledRoot : completionsRoot;
    const content = processFile(restoredRoot, parts.join('/'));
    if (content.bytes !== item.bytes || content.sha256 !== item.sha256) throw new Error('Restored object differs from verified checkpoint');
  }
  await client.query("UPDATE submission_sources SET storage_path = $1 || '/' || digest || '.zip'", [sourceRoot]);
  await client.query("UPDATE replay_objects SET storage_path = $1 || '/' || digest || '.oantuti'", [replayRoot]);
  await client.query(`UPDATE job_completions SET restore_recovery = true WHERE state = 'PENDING'`);
  await client.query(`UPDATE job_attempts SET state = 'EXPIRED' WHERE state = 'ACTIVE'
    AND job_id NOT IN (SELECT job_id FROM job_completions WHERE state = 'PENDING')`);
  await client.query(`UPDATE test_snapshots SET status = 'COMPLETED', started_at = NULL
    WHERE status = 'RUNNING' AND result_payload IS NULL AND id IN
      (SELECT target_id FROM jobs WHERE job_type = 'TEST_GAME' AND state NOT IN ('SUCCEEDED','BLOCKED','COMPLETION_PENDING'))`);
  await client.query(`UPDATE jobs SET deployment_generation = $1, fencing_token = fencing_token + 1, active_lease_id = NULL,
    state = CASE WHEN state IN ('SUCCEEDED','BLOCKED') THEN state ELSE 'QUEUED' END, available_at = clock_timestamp(), updated_at = clock_timestamp()
    WHERE id NOT IN (SELECT job_id FROM job_completions WHERE state = 'PENDING')`, [generation]);
  await client.query('DELETE FROM backup_checkpoints');
  // The pre-026 heartbeat key is removed here: freshness now derives from verified checkpoints, and
  // a stale heartbeat must never survive as evidence of a generation that no longer exists.
  await client.query("DELETE FROM deployment_settings WHERE key = 'backup_status'");
  return generation;
}

export async function resolveDeploymentGeneration(db: PostgresDatabase, configured?: number): Promise<number> {
  const identity = await db.query<{ generation: number }>('SELECT generation FROM backup_identity WHERE singleton');
  const generation = identity.rows[0]?.generation;
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('Missing deployment generation; apply migration 026');
  if (configured !== undefined && configured !== generation) throw new Error('Configured generation does not match database');
  return generation;
}
