import { describe, it, expect } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/persistence/db.js';
import { ArtifactStore } from '../src/submissions/artifact-store.js';
import { ReplayStore } from '../src/results/replay-store.js';

describe('evidence object roots must be private', () => {
  it('refuses an operator-supplied root that other identities can read, and never chmods it', () => {
    const root = mkdtempSync(join(tmpdir(), 'private-root-'));
    try {
      const loose = join(root, 'loose');
      mkdirSync(loose, { mode: 0o755 });
      chmodSync(loose, 0o755);
      const db = new Database(':memory:');
      expect(() => new ArtifactStore(db, loose)).toThrow('must not be group/world accessible');
      expect(() => new ReplayStore(loose, join(root, 'staging'))).toThrow('must not be group/world accessible');
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('creates a missing root privately', () => {
    const root = mkdtempSync(join(tmpdir(), 'private-root-new-'));
    try {
      const db = new Database(':memory:');
      const store = new ArtifactStore(db, join(root, 'created'));
      expect(store.storageRoot).toBe(join(root, 'created'));
      rmSync(join(root, 'created'), { recursive: true, force: true });
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
