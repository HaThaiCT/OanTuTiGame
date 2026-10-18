import assert from 'node:assert/strict';
import { it as test } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateRebuildConfig } from '../deploy/linux/rebuild-config.mts';

const root = '/private/oantuti/rebuild/c72cd5a7-4f33-44ae-82da-723b6953024d';
const fixture = () => ({
  schemaVersion: 1,
  purpose: 'ISOLATED_REBUILD_DEVELOPMENT',
  deploymentId: 'c72cd5a7-4f33-44ae-82da-723b6953024d',
  profile: 'LAN_OFFLINE',
  bindAddress: '127.0.0.1',
  webPort: 4300,
  apiPort: 4301,
  runtimeRoot: root,
  pgDatabase: 'arena_rebuild_c72cd5a74f33',
  pgSocketPath: `${root}/pg16/socket`,
  pgPort: 55434,
  pgAppRole: 'arena_rebuild_app',
  pgMigratorRole: 'arena_rebuild_migrator',
  pgBackupRole: 'arena_rebuild_backup',
  objectRoot: `${root}/objects`,
  stagingRoot: `${root}/staging`,
  spoolRoot: `${root}/spool`,
});
const forbiddenRoots = ['/private/oantuti/development'];

test('accepts isolated paths without asserting release or runtime readiness', () => {
  const result = validateRebuildConfig(fixture(), forbiddenRoots);
  assert.equal(result.ok, true);
  assert.equal(result.releaseReady, false);
  assert.equal(result.runtimeCertification, 'PENDING_RUNTIME_PROOF');
});

for (const [name, change, field] of [
  ['old database', { pgDatabase: 'arena_development' }, 'pgDatabase'],
  ['donor objects', { objectRoot: '/private/oantuti/development/objects' }, 'objectRoot'],
  ['path traversal', { spoolRoot: `${root}/../development` }, 'spoolRoot'],
  ['nested spool in objects', { spoolRoot: `${root}/objects/spool` }, 'spoolRoot'],
  ['objects containing database socket', { objectRoot: `${root}/pg16` }, 'objectRoot'],
  ['shared DDL role', { pgAppRole: 'arena_rebuild_migrator' }, 'pgAppRole'],
  ['public bind', { bindAddress: '0.0.0.0' }, 'bindAddress'],
  ['same listening port', { apiPort: 4300 }, 'apiPort'],
  ['noninteger port', { webPort: 4300.5 }, 'webPort'],
  ['unexpected secret', { password: 'DO_NOT_ECHO_THIS' }, 'password'],
  ['claiming production', { releaseReady: true }, 'releaseReady'],
]) {
  test(`rejects ${name} without echoing values`, () => {
    const result = validateRebuildConfig({ ...fixture(), ...change }, forbiddenRoots);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => error.field === field));
    assert.ok(!JSON.stringify(result).includes('DO_NOT_ECHO_THIS'));
  });
}

test('rejects missing and non-object configuration explicitly', () => {
  for (const input of [null, [], 'config', {}]) {
    const result = validateRebuildConfig(input, forbiddenRoots);
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
  }
});

test('rejects storage symlink into donor data even when lexical path is isolated', () => {
  const directory = mkdtempSync(join(tmpdir(), 'arena-config-'));
  try {
    const runtime = join(directory, 'rebuild');
    const donor = join(directory, 'donor');
    mkdirSync(runtime, { mode: 0o700 });
    mkdirSync(donor, { mode: 0o700 });
    symlinkSync(donor, join(runtime, 'objects'));
    const input = { ...fixture(), runtimeRoot: runtime, objectRoot: join(runtime, 'objects'),
      pgSocketPath: join(runtime, 'pg/socket'), stagingRoot: join(runtime, 'staging'), spoolRoot: join(runtime, 'spool') };
    const result = validateRebuildConfig(input, [donor]);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => error.field === 'objectRoot' && error.code === 'UNSAFE_FILESYSTEM_PATH'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects existing runtime roots readable by other local users', () => {
  const directory = mkdtempSync(join(tmpdir(), 'arena-config-mode-'));
  try {
    const runtime = join(directory, 'rebuild');
    mkdirSync(runtime, { mode: 0o755 });
    const input = { ...fixture(), runtimeRoot: runtime, objectRoot: join(runtime, 'objects'),
      pgSocketPath: join(runtime, 'pg/socket'), stagingRoot: join(runtime, 'staging'), spoolRoot: join(runtime, 'spool') };
    const result = validateRebuildConfig(input, []);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => error.field === 'runtimeRoot'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
