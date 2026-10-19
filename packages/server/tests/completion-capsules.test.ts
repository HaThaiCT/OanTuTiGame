import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readdirSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepCompletionCapsules } from '../src/operations/completion-capsules.js';

const DAY = 24 * 60 * 60 * 1_000;

describe('completion capsule reclamation', () => {
  it('deletes only stale capsules that no pending completion names, and their unshared objects', () => {
    const root = mkdtempSync(join(tmpdir(), 'capsules-'));
    try {
      const old = Date.now() - 30 * DAY;
      const pending = 'a'.repeat(64);
      const accepted = 'b'.repeat(64);
      const sharedObject = 'c'.repeat(64);
      const soloObject = 'd'.repeat(64);
      writeFileSync(join(root, `${pending}.json`), JSON.stringify({ objects: [{ digest: sharedObject }] }));
      writeFileSync(join(root, `${accepted}.json`), JSON.stringify({ objects: [{ digest: sharedObject }, { digest: soloObject }] }));
      writeFileSync(join(root, `${sharedObject}.object`), 'shared');
      writeFileSync(join(root, `${soloObject}.object`), 'solo');
      for (const name of readdirSync(root)) {
        utimesSync(join(root, name), new Date(old), new Date(old));
      }

      const swept = sweepCompletionCapsules(root, new Set([pending]));
      expect(swept.capsules).toBe(1);
      expect(swept.objects).toBe(1);
      const left = readdirSync(root).sort();
      // The pending capsule and the object it shares survive; the accepted capsule and its private
      // object are gone.
      expect(left).toEqual([`${pending}.json`, `${sharedObject}.object`].sort());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a fresh capsule and tolerates a missing directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'capsules-fresh-'));
    try {
      writeFileSync(join(root, `${'e'.repeat(64)}.json`), JSON.stringify({ objects: [] }));
      expect(sweepCompletionCapsules(root, new Set())).toEqual({ capsules: 0, objects: 0 });
      expect(readdirSync(root)).toHaveLength(1);
      expect(sweepCompletionCapsules(join(root, 'absent'), new Set())).toEqual({ capsules: 0, objects: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
