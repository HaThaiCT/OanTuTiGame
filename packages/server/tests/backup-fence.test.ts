import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgresDatabase } from '../src/persistence/db.js';
import {
  BackupFence,
  BackupLagError,
  BACKUP_STATUS_KEY,
  backupFenceConfigFromEnv,
} from '../src/operations/backup-fence.js';

/**
 * Backup-lag write fence (S15): protected writes pause when the backup heartbeat is missing or older
 * than the limit — but only when the operator enabled enforcement, because the development stack has
 * no scheduled backup pipeline.
 */
describe('S15: backup-lag write fence', () => {
  let db: PostgresDatabase;

  beforeAll(async () => {
    db = new PostgresDatabase();
    await db.query('DELETE FROM deployment_settings WHERE key = $1', [BACKUP_STATUS_KEY]);
  });

  afterAll(async () => {
    await db.query('DELETE FROM deployment_settings WHERE key = $1', [BACKUP_STATUS_KEY]);
    await db.close();
  });

  it('is a no-op while enforcement is off', async () => {
    const fence = new BackupFence(db, { enforcement: 'off', maxLagMinutes: 5 });
    await expect(fence.assertFresh()).resolves.toBeUndefined();
    const status = await fence.status();
    expect(status).toMatchObject({ enforced: false, stale: true, lastSuccessAt: null, maxLagMinutes: 5 });
  });

  it('refuses protected writes until a backup is recorded, and again once it is stale', async () => {
    const fence = new BackupFence(db, { enforcement: 'enforce', maxLagMinutes: 5 });

    const missing = await fence.assertFresh().catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(BackupLagError);
    expect((missing as BackupLagError).statusCode).toBe(409);
    expect((missing as BackupLagError).message).toContain('no successful backup');

    await fence.recordSuccess(new Date(Date.now() - 10 * 60_000));
    const stale = await fence.assertFresh().catch((error: unknown) => error);
    expect(stale).toBeInstanceOf(BackupLagError);
    expect((stale as BackupLagError).message).toContain('minutes old');

    const status = await fence.status();
    expect(status.stale).toBe(true);
    expect(status.lagMinutes).toBeGreaterThanOrEqual(10);

    await fence.recordSuccess();
    await expect(fence.assertFresh()).resolves.toBeUndefined();
    const fresh = await fence.status();
    expect(fresh.stale).toBe(false);
    expect(fresh.lagMinutes).toBeLessThan(1);
  });

  it('reads enforcement and the lag limit from the environment', () => {
    expect(backupFenceConfigFromEnv({})).toEqual({ enforcement: 'off', maxLagMinutes: 5 });
    expect(backupFenceConfigFromEnv({ OANTUTI_BACKUP_FENCE: 'enforce' })).toEqual({
      enforcement: 'enforce',
      maxLagMinutes: 5,
    });
    expect(
      backupFenceConfigFromEnv({ OANTUTI_BACKUP_FENCE: 'ON', OANTUTI_BACKUP_MAX_LAG_MINUTES: '12' })
    ).toEqual({ enforcement: 'enforce', maxLagMinutes: 12 });
    expect(backupFenceConfigFromEnv({ OANTUTI_BACKUP_MAX_LAG_MINUTES: 'nope' })).toEqual({
      enforcement: 'off',
      maxLagMinutes: 5,
    });
  });
});
