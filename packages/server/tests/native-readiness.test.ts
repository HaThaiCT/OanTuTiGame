import { describe, it, expect } from 'vitest';
import { readinessReport } from '../src/operations/readiness.js';
import { EXPECTED_SCHEMA_VERSION } from '../src/persistence/schema-version.js';

describe('native worker readiness', () => {
  it('keeps an empty gateway degraded until authenticated game and build workers are available', async () => {
    let available = false;
    const database = { async query<T extends Record<string, unknown>>() {
      return { rows: [{ version: EXPECTED_SCHEMA_VERSION, max: EXPECTED_SCHEMA_VERSION }] as unknown as T[] };
    } };
    const inputs = { database, executionGateway: { isReady: () => true, capabilities: async () => ({ officialGame: available, build: available, privateTest: available }) },
      devExecutorEnabled: false, backupFence: { status: async () => ({ enforced: true, stale: false, lagMinutes: 0, maxLagMinutes: 5, checkpoint: {} }) } };
    const empty = await readinessReport(inputs);
    expect(empty.productionReady).toBe(false);
    expect(empty.accepts).toEqual({ officialGame: false, build: false, privateTest: false });
    available = true;
    const connected = await readinessReport(inputs);
    expect(connected.accepts).toEqual({ officialGame: true, build: true, privateTest: true });
    expect(connected.checks.find(check => check.name === 'workers')?.ok).toBe(true);
  });

  it('reports a database whose recorded object paths sit outside the configured roots', async () => {
    const inputs = {
      database: { async query<T extends Record<string, unknown>>() { return { rows: [{ version: EXPECTED_SCHEMA_VERSION }] as unknown as T[] }; } },
      executionGateway: { isReady: () => true, capabilities: async () => ({ officialGame: true, build: true, privateTest: true }) },
      devExecutorEnabled: false,
      objectRoots: { async check() { return { ok: false, detail: 'submission_sources references /old/root/x.zip, outside /srv/replays' }; } },
    };
    const report = await readinessReport(inputs);
    const roots = report.checks.find((check) => check.name === 'objectRoots');
    expect(roots?.ok).toBe(false);
    expect(roots?.detail).toContain('outside');
    expect(report.status).toBe('degraded');
  });
});
