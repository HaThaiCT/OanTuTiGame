/** Backup restore-point fence backed only by destination-byte-verified checkpoint records. */
import { statementRunner, type PostgresDatabase } from '../persistence/db.js';
import type pg from 'pg';
import { BACKUP_BARRIER, type VerifiedBackupCheckpoint } from './backup-checkpoint.js';
export type { VerifiedBackupCheckpoint } from './backup-checkpoint.js';

export const DEFAULT_MAX_LAG_MINUTES = 5;

export type BackupFenceEnforcement = 'off' | 'enforce';

export interface BackupFenceConfig {
  readonly enforcement: BackupFenceEnforcement;
  readonly maxLagMinutes: number;
}


export interface BackupFenceStatus {
  readonly enforced: boolean;
  readonly stale: boolean;
  readonly checkpoint: VerifiedBackupCheckpoint | null;
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

function validateConfig(config: BackupFenceConfig): void {
  if (config.enforcement !== 'off' && config.enforcement !== 'enforce') {
    throw new Error('OANTUTI_BACKUP_FENCE must explicitly be off or enforce');
  }
  if (!Number.isFinite(config.maxLagMinutes) || config.maxLagMinutes <= 0) {
    throw new Error('OANTUTI_BACKUP_MAX_LAG_MINUTES must be a positive finite number');
  }
}

export function backupFenceConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BackupFenceConfig {
  const config: BackupFenceConfig = {
    enforcement: env.OANTUTI_BACKUP_FENCE as BackupFenceEnforcement,
    maxLagMinutes: env.OANTUTI_BACKUP_MAX_LAG_MINUTES === undefined
      ? DEFAULT_MAX_LAG_MINUTES
      : Number(env.OANTUTI_BACKUP_MAX_LAG_MINUTES),
  };
  validateConfig(config);
  return config;
}

function timestamp(value: unknown): number {
  if (typeof value !== 'string') return Number.NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : Number.NaN;
}

function validatedCheckpoint(value: unknown, now: Date): VerifiedBackupCheckpoint | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const report = value as Record<string, unknown>;
  if (typeof report.manifestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(report.manifestDigest)
      || typeof report.deploymentId !== 'string' || !Number.isSafeInteger(report.generation)) return null;
  const checkpointMs = timestamp(report.checkpointAt);
  const verificationMs = timestamp(report.verificationAt);
  const nowMs = now.getTime();
  // No positive skew allowance: neither a future restore point nor future verification is evidence.
  if (!Number.isFinite(nowMs) || !Number.isFinite(checkpointMs) || !Number.isFinite(verificationMs)
      || checkpointMs > verificationMs || verificationMs > nowMs) return null;
  return {
    manifestDigest: report.manifestDigest,
    checkpointAt: report.checkpointAt as string,
    deploymentId: report.deploymentId,
    generation: report.generation as number,
    verificationAt: report.verificationAt as string,
  };
}

export class BackupFence {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly config: BackupFenceConfig = backupFenceConfigFromEnv()
  ) {
    validateConfig(config);
  }

  async status(now: Date = new Date(), client?: pg.PoolClient): Promise<BackupFenceStatus> {
    const result = await statementRunner(client ?? this.db)<{ value: unknown }>(
      `SELECT jsonb_build_object('manifestDigest', c.manifest_digest, 'checkpointAt',
        to_char(c.checkpoint_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'verificationAt', to_char(c.verification_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'deploymentId', c.deployment_id, 'generation', c.generation) AS value
       FROM backup_checkpoints c JOIN backup_identity i ON i.singleton
        AND i.deployment_id = c.deployment_id AND i.generation = c.generation
       ORDER BY c.checkpoint_at DESC LIMIT 1`
    );
    const checkpoint = validatedCheckpoint(result.rows[0]?.value, now);
    const lagMinutes = checkpoint === null ? null : (now.getTime() - Date.parse(checkpoint.checkpointAt)) / 60_000;
    return {
      enforced: this.config.enforcement === 'enforce',
      stale: lagMinutes === null || lagMinutes > this.config.maxLagMinutes,
      checkpoint,
      lagMinutes: lagMinutes === null ? null : Math.round(lagMinutes * 10) / 10,
      maxLagMinutes: this.config.maxLagMinutes,
    };
  }

  /** Refuses submissions, admissions and lifecycle transitions without a fresh verified restore point. */
  async assertFresh(client?: pg.PoolClient): Promise<void> {
    if (client) await client.query(`SELECT pg_advisory_xact_lock_shared(${BACKUP_BARRIER})`);
    if (this.config.enforcement === 'off') return;
    const status = await this.status(new Date(), client);
    if (!status.stale) return;
    throw new BackupLagError(
      status.checkpoint === null
        ? 'Protected writes are paused: no valid verified offhost backup checkpoint has been recorded (OANTUTI_BACKUP_FENCE=enforce)'
        : `Protected writes are paused: the verified offhost restore point is ${status.lagMinutes} minutes old (limit ${status.maxLagMinutes} minutes)`
    );
  }

}
