import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withShowcaseLock } from '../deploy/linux/demo-showcase-lock.js';

describe('showcase run lock', () => {
  it('serializes concurrent invocations and releases the lock after completion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'showcase-lock-'));
    const path = join(root, 'run.lock');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    try {
      const first = withShowcaseLock(path, async () => { await gate; return 'first'; });
      await expect(withShowcaseLock(path, async () => 'second')).rejects.toThrow(/already running/);
      release();
      await expect(first).resolves.toBe('first');
      await expect(withShowcaseLock(path, async () => 'third')).resolves.toBe('third');
    } finally {
      release();
      await rm(root, { recursive: true, force: true });
    }
  });
});
