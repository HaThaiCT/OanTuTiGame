import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { EXPECTED_SCHEMA_VERSION } from '../src/persistence/schema-version.js';

describe('schema version constant', () => {
  it('equals the newest migration this build ships', () => {
    const dir = join(process.cwd(), 'packages/server/src/persistence/migrations');
    const versions = readdirSync(dir)
      .filter((name) => /^\d{3}-.+\.sql$/.test(name))
      .map((name) => Number.parseInt(name.slice(0, 3), 10));
    expect(versions.length).toBeGreaterThan(0);
    const newest = Math.max(...versions);
    // A migration added without this constant leaves readiness reporting a mismatch on a database
    // that is actually current — and an operator with no way to tell which side is wrong.
    expect(EXPECTED_SCHEMA_VERSION).toBe(newest);
  });
});
