import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/persistence/db.js';
import { ArtifactStore } from '../src/submissions/artifact-store.js';
import { ReplayStore } from '../src/results/replay-store.js';

const envKeys = ['OANTUTI_SUBMISSION_DIR', 'OANTUTI_REPLAYS_DIR', 'OANTUTI_REPLAY_STAGING_DIR', 'OANTUTI_OBJECTS_DIR'] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key] ?? null]));
afterEach(() => {
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('evidence object roots must be private', () => {
  it('refuses operator roots without changing their permissions', () => {
    const root = mkdtempSync(join(tmpdir(), 'private-root-'));
    const source = join(root, 'source');
    const objects = join(root, 'objects');
    const staging = join(root, 'staging');
    mkdirSync(source, { mode: 0o755 }); chmodSync(source, 0o755);
    mkdirSync(objects, { mode: 0o755 }); chmodSync(objects, 0o755);
    mkdirSync(staging, { mode: 0o755 }); chmodSync(staging, 0o755);
    const db = new Database(':memory:');
    try {
      expect(() => new ArtifactStore(db, source)).toThrow('must not be group/world accessible');
      expect(() => new ReplayStore(objects, staging)).toThrow('must not be group/world accessible');
      expect(statSync(source).mode & 0o777).toBe(0o755);
      expect(statSync(objects).mode & 0o777).toBe(0o755);
      expect(statSync(staging).mode & 0o777).toBe(0o755);
    } finally {
      void db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('creates a missing root privately', () => {
    const root = mkdtempSync(join(tmpdir(), 'private-root-new-'));
    const db = new Database(':memory:');
    try {
      const storeRoot = join(root, 'created');
      const store = new ArtifactStore(db, storeRoot);
      expect(store.storageRoot).toBe(storeRoot);
      expect(statSync(storeRoot).mode & 0o777).toBe(0o700);
    } finally {
      void db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('tightens an explicitly app-owned root', () => {
    const root = mkdtempSync(join(tmpdir(), 'private-root-owned-'));
    const source = join(root, 'source');
    mkdirSync(source, { mode: 0o755 }); chmodSync(source, 0o755);
    const db = new Database(':memory:');
    try {
      new ArtifactStore(db, source, { ownedByConvention: true });
      expect(statSync(source).mode & 0o777).toBe(0o700);
    } finally {
      void db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects permissive operator environment roots and shared-root children', () => {
    const root = mkdtempSync(join(tmpdir(), 'private-root-env-'));
    const db = new Database(':memory:');
    try {
      const source = join(root, 'source-env'); mkdirSync(source, { mode: 0o755 }); chmodSync(source, 0o755);
      process.env.OANTUTI_SUBMISSION_DIR = source;
      expect(() => new ArtifactStore(db)).toThrow('must not be group/world accessible');
      expect(statSync(source).mode & 0o777).toBe(0o755);
      delete process.env.OANTUTI_SUBMISSION_DIR;

      const replays = join(root, 'replays-env'); mkdirSync(replays, { mode: 0o755 }); chmodSync(replays, 0o755);
      process.env.OANTUTI_REPLAYS_DIR = replays;
      expect(() => new ReplayStore()).toThrow('must not be group/world accessible');
      expect(statSync(replays).mode & 0o777).toBe(0o755);
      delete process.env.OANTUTI_REPLAYS_DIR;

      const staging = join(root, 'staging-env'); mkdirSync(staging, { mode: 0o755 }); chmodSync(staging, 0o755);
      process.env.OANTUTI_REPLAY_STAGING_DIR = staging;
      expect(() => new ReplayStore()).toThrow('must not be group/world accessible');
      expect(statSync(staging).mode & 0o777).toBe(0o755);
      delete process.env.OANTUTI_REPLAY_STAGING_DIR;

      const shared = join(root, 'shared');
      const child = join(shared, 'sources'); mkdirSync(child, { recursive: true, mode: 0o755 }); chmodSync(child, 0o755);
      process.env.OANTUTI_OBJECTS_DIR = shared;
      process.env.OANTUTI_SUBMISSION_DIR = child;
      expect(() => new ArtifactStore(db)).toThrow('must not be group/world accessible');
      expect(statSync(child).mode & 0o777).toBe(0o755);
    } finally {
      void db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects empty configured environment roots', () => {
    const db = new Database(':memory:');
    try {
      process.env.OANTUTI_SUBMISSION_DIR = '';
      expect(() => new ArtifactStore(db)).toThrow('OANTUTI_SUBMISSION_DIR');
      delete process.env.OANTUTI_SUBMISSION_DIR;
      process.env.OANTUTI_REPLAYS_DIR = '';
      expect(() => new ReplayStore()).toThrow('OANTUTI_REPLAYS_DIR');
    } finally {
      void db.close();
    }
  });

  it('evaluates replay objects and staging ownership independently', () => {
    const root = mkdtempSync(join(tmpdir(), 'private-root-split-'));
    const objects = join(root, 'objects');
    const staging = join(root, 'staging');
    mkdirSync(objects, { mode: 0o700 });
    mkdirSync(staging, { mode: 0o755 }); chmodSync(staging, 0o755);
    try {
      new ReplayStore(objects, staging, { storageOwnedByConvention: false, stagingOwnedByConvention: true });
      expect(statSync(objects).mode & 0o777).toBe(0o700);
      expect(statSync(staging).mode & 0o777).toBe(0o700);
      chmodSync(objects, 0o755);
      expect(() => new ReplayStore(objects, staging, { storageOwnedByConvention: false, stagingOwnedByConvention: true })).toThrow('must not be group/world accessible');
      expect(statSync(objects).mode & 0o777).toBe(0o755);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
