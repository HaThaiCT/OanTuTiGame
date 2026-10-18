/**
 * Backup-lag write fence (05-SECURITY-OPERATIONS §7, S15).
 *
 * The operations baseline says protected writes stop once the last successful backup is older than
 * the agreed lag: a silent backup failure must not let the only copy of the data drift away while
 * new submissions, admissions and tournament transitions keep committing.
 *
 * Enforcement is opt-in (`OANTUTI_BACKUP_FENCE=enforce`) because the development stack has no
 * scheduled backup pipeline; with the fence off every check is a no-op. The heartbeat
 * (`deployment_settings.backup_status.lastSuccessAt`) is written by whatever actually completed a
 * verified backup — `deploy/linux/wal-restore-drill.py` does it after a successful restore, and
 * operators can update the same row from their backup job.
 */
import type { PostgresDatabase } from '../persistence/db.js';

export const BACKUP_STATUS_KEY = 'backup_status';
export const DEFAULT_MAX_LAG_MINUTES = 5;

export type BackupFenceEnforcement = 'off' | 'enforce';

export interface BackupFenceConfig {
  readonly enforcement: BackupFenceEnforcement;
  readonly maxLagMinutes: number;
}

export interface BackupFenceStatus {
  readonly enforced: boolean;
  readonly stale: boolean;
  readonly lastSuccessAt: string | null;
  readonly lagMinutes: number | null;
  readonly maxLagMinutes: number;
}

export class BackupLagError extends Error {
  readonly statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = 'BackupLagError';
  }
}

export function backupFenceConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BackupFenceConfig {
  const raw = (env.OANTUTI_BACKUP_FENCE ?? '').trim().toLowerCase();
  const enforcement: BackupFenceEnforcement = raw === 'enforce' || raw === 'on' ? 'enforce' : 'off';
  const parsedLag = Number(env.OANTUTI_BACKUP_MAX_LAG_MINUTES ?? '');
  const maxLagMinutes = Number.isFinite(parsedLag) && parsedLag > 0 ? parsedLag : DEFAULT_MAX_LAG_MINUTES;
  return { enforcement, maxLagMinutes };
}

export class BackupFence {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly config: BackupFenceConfig = backupFenceConfigFromEnv()
  ) {}

  async status(now: Date = new Date()): Promise<BackupFenceStatus> {
    const result = await this.db.query<{ value: { lastSuccessAt?: string } | null }>(
      'SELECT value FROM deployment_settings WHERE key = $1',
      [BACKUP_STATUS_KEY]
    );
    const reported = result.rows[0]?.value?.lastSuccessAt;
    const lastSuccessAt = typeof reported === 'string' ? reported : null;
    const lastMs = lastSuccessAt === null ? Number.NaN : Date.parse(lastSuccessAt);
    const lagMinutes = Number.isFinite(lastMs) ? (now.getTime() - lastMs) / 60_000 : null;
    return {
      enforced: this.config.enforcement === 'enforce',
      stale: lagMinutes === null || lagMinutes > this.config.maxLagMinutes,
      lastSuccessAt,
      lagMinutes: lagMinutes === null ? null : Math.round(lagMinutes * 10) / 10,
      maxLagMinutes: this.config.maxLagMinutes,
    };
  }

  /**
   * Refuses a protected write when the fence is enforced and the heartbeat is missing or too old.
   * Callers use it for submissions, admissions and the lock/start/finalize transitions.
   */
  async assertFresh(): Promise<void> {
    if (this.config.enforcement !== 'enforce') return;
    const status = await this.status();
    if (!status.stale) return;
    throw new BackupLagError(
      status.lastSuccessAt === null
        ? 'Protected writes are paused: no successful backup has been recorded yet (OANTUTI_BACKUP_FENCE=enforce)'
        : `Protected writes are paused: the last successful backup is ${status.lagMinutes} minutes old (limit ${status.maxLagMinutes} minutes)`
    );
  }

  /**
   * Records a completed backup. Called by the restore drill and by the operator's backup job; this
   * is deliberately not exposed through any HTTP route.
   */
  async recordSuccess(at: Date = new Date()): Promise<void> {
    await this.db.query(
      `INSERT INTO deployment_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [BACKUP_STATUS_KEY, JSON.stringify({ lastSuccessAt: at.toISOString() })]
    );
  }
}
