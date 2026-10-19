import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BackupFence, BackupLagError, backupFenceConfigFromEnv } from '../src/operations/backup-fence.js';
import { verifyCheckpoint, publishCheckpoint, activateRestoredGeneration, type BackupManifest } from '../src/operations/backup-checkpoint.js';
import type { PostgresDatabase } from '../src/persistence/db.js';

const temporary: string[] = [];
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'checkpoint-'));
  temporary.push(root);
  mkdirSync(path.join(root, 'sources'), { mode: 0o700 });
  const database = Buffer.from('database bytes');
  const source = Buffer.from('source bytes');
  writeFileSync(path.join(root, 'database.dump'), database, { mode: 0o600 });
  writeFileSync(path.join(root, 'sources/a.zip'), source, { mode: 0o600 });
  const manifest: BackupManifest = { version: 1, deploymentId: '12345678-1234-1234-1234-123456789abc', generation: 1,
    checkpointAt: new Date(Date.now() - 60_000).toISOString(),
    database: { name: 'arena', snapshot: '0001-0002-1', restoreLsn: '0/A', file: { path: 'database.dump', bytes: database.length, sha256: createHash('sha256').update(database).digest('hex') } },
    objects: [{ path: 'sources/a.zip', bytes: source.length, sha256: createHash('sha256').update(source).digest('hex') }], restoreContract: 'logical-snapshot-requeue-new-generation-v1' };
  const bytes = Buffer.from(JSON.stringify(manifest));
  writeFileSync(path.join(root, 'manifest.json'), bytes, { mode: 0o600 });
  return { root, manifest, digest: createHash('sha256').update(bytes).digest('hex') };
}

describe('byte-verified checkpoint boundary', () => {
  it('verifies manifest and every object against an independent digest', () => {
    const { root, digest } = fixture();
    expect(verifyCheckpoint(root, digest)).toMatchObject({ manifestDigest: digest, generation: 1 });
    expect(() => verifyCheckpoint(root, '0'.repeat(64))).toThrow('Manifest digest mismatch');
  });
  it('rejects missing, corrupt, extra, public and symlink objects', () => {
    for (const alteration of ['missing', 'corrupt', 'extra', 'public', 'symlink']) {
      const { root, digest } = fixture();
      const file = path.join(root, 'sources/a.zip');
      if (alteration === 'missing') rmSync(file);
      if (alteration === 'corrupt') writeFileSync(file, 'wrong');
      if (alteration === 'extra') writeFileSync(path.join(root, 'extra'), 'x', { mode: 0o600 });
      if (alteration === 'public') chmodSync(file, 0o644);
      if (alteration === 'symlink') { rmSync(file); symlinkSync('../database.dump', file); }
      expect(() => verifyCheckpoint(root, digest)).toThrow();
    }
  });
  it('rejects plain JSON and boolean attestations before touching a database', async () => {
    const db = {} as PostgresDatabase;
    await expect(publishCheckpoint(db, { manifestDigest: 'a'.repeat(64), verifiedOffHost: true } as never)).rejects.toThrow('must be verified');
    const { root, digest } = fixture();
    const report = verifyCheckpoint(root, digest);
    await expect(publishCheckpoint(db, { ...report })).rejects.toThrow('must be verified');
    await expect(activateRestoredGeneration({} as never, { ...report }, { sources: root, replays: root, compiled: root, completions: root })).rejects.toThrow('byte-verified');
  });
  it('requires a dedicated publisher role even after successful byte verification', async () => {
    const { root, digest } = fixture();
    const db = { withTransaction: async (fn: (client: unknown) => Promise<void>) => fn({ query: async () => ({ rows: [{ allowed: false }] }) }) } as unknown as PostgresDatabase;
    await expect(publishCheckpoint(db, verifyCheckpoint(root, digest))).rejects.toThrow('dedicated');
  });
  it('fences new work while preserving pinned completion identity on restore', async () => {
    const { root, digest } = fixture();
    const report = verifyCheckpoint(root, digest);
    const calls: string[] = [];
    const client = { query: async (sql: string) => { calls.push(sql); return { rows: [{ generation: 2 }] }; } };
    const generation = await activateRestoredGeneration(client as never, report, { sources: path.join(root, 'sources'), replays: root, compiled: root, completions: root });
    expect(generation).toBe(2);
    expect(calls.some((sql) => sql.includes('restore_recovery = true'))).toBe(true);
    expect(calls.some((sql) => sql.includes("WHERE id NOT IN (SELECT job_id FROM job_completions WHERE state = 'PENDING')"))).toBe(true);
    expect(calls.some((sql) => sql.includes("SET state = 'REJECTED'"))).toBe(false);
  });
});

describe('restore-point write fence', () => {
  it('fails closed with no verified checkpoint and ignores legacy attestation settings', async () => {
    const db = { query: async () => ({ rows: [] }) } as unknown as PostgresDatabase;
    const fence = new BackupFence(db, { enforcement: 'enforce', maxLagMinutes: 5 });
    await expect(fence.assertFresh()).rejects.toBeInstanceOf(BackupLagError);
    expect(await fence.status()).toMatchObject({ stale: true, checkpoint: null });
  });
  it('measures exact unrounded lag and binds transaction freshness to the barrier', async () => {
    const now = new Date('2026-10-18T12:00:00.000Z');
    const calls: string[] = [];
    const report = { manifestDigest: 'a'.repeat(64), deploymentId: '12345678-1234-1234-1234-123456789abc', generation: 1,
      checkpointAt: new Date(now.getTime() - 300_000).toISOString(), verificationAt: now.toISOString() };
    const db = { query: async (sql: string) => { calls.push(sql); return { rows: [{ value: report }] }; } } as unknown as PostgresDatabase;
    const fence = new BackupFence(db, { enforcement: 'enforce', maxLagMinutes: 5 });
    expect((await fence.status(now)).stale).toBe(false);
    expect((await fence.status(new Date(now.getTime() + 1))).stale).toBe(true);
    const off = new BackupFence(db, { enforcement: 'off', maxLagMinutes: 5 });
    await off.assertFresh(db as never);
    expect(calls.at(-1)).toContain('pg_advisory_xact_lock_shared');
  });
  it('requires explicit configuration', () => {
    expect(backupFenceConfigFromEnv({ OANTUTI_BACKUP_FENCE: 'off' })).toEqual({ enforcement: 'off', maxLagMinutes: 5 });
    for (const mode of [undefined, '', 'on', 'OFF']) expect(() => backupFenceConfigFromEnv({ OANTUTI_BACKUP_FENCE: mode })).toThrow();
    for (const lag of ['', '0', '-1', 'Infinity']) expect(() => backupFenceConfigFromEnv({ OANTUTI_BACKUP_FENCE: 'enforce', OANTUTI_BACKUP_MAX_LAG_MINUTES: lag })).toThrow();
  });
});
