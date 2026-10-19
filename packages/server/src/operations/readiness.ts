/**
 * Execution readiness, kept separate from liveness.
 *
 * Spec `05-SECURITY-OPERATIONS-QUALITY.md` §2.1: liveness only reports that the process is alive,
 * readiness reports whether the deployment can accept the job types it promises, and public reads
 * stay available while the execution plane is degraded. This module therefore never guesses from
 * configuration intent: every check reads real state — a database query, the gateway's own
 * readiness flag, the stored backup checkpoint — and a failing check carries a machine-readable
 * reason. It reports capability, not certification: a report that says `ready` in this LAN build
 * does not claim that the sandbox profile was certified on this host.
 */
import { EXPECTED_SCHEMA_VERSION } from '../persistence/schema-version.js';

export interface ReadinessCheck {
  readonly name: string;
  readonly ok: boolean;
  /** Why the check passed or failed; never contains a secret value. */
  readonly detail: string;
}

export interface ReadinessAccepts {
  readonly officialGame: boolean;
  readonly build: boolean;
  readonly privateTest: boolean;
}

export interface ReadinessReport {
  /** `ready` only when every check passes; `degraded` otherwise, with the reasons listed. */
  readonly status: 'ready' | 'degraded';
  /** True when nothing in the wired configuration is known to be unsafe for real competition work. */
  readonly productionReady: boolean;
  readonly accepts: ReadinessAccepts;
  readonly checks: readonly ReadinessCheck[];
  readonly schemaVersion: number;
  /** Version this build expects; equal to `schemaVersion` on a migrated database. */
  readonly expectedSchemaVersion: number;
  readonly timestamp: string;
}

export interface ReadinessQueryable {
  query<T extends Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
}

export interface BackupFenceLike {
  status(): Promise<{
    readonly enforced: boolean;
    readonly stale: boolean;
    readonly lagMinutes: number | null;
    readonly maxLagMinutes: number;
    readonly checkpoint: unknown;
  }>;
}

export interface ReadinessInputs {
  /** Control plane database. v2 requires PostgreSQL, so its absence fails the check. */
  readonly database?: ReadinessQueryable;
  readonly executionGateway?: { isReady(): boolean; capabilities?(): Promise<ReadinessAccepts> };
  /** The unsandboxed development executor, which must never be armed for a real competition. */
  readonly devExecutorEnabled: boolean;
  readonly backupFence?: BackupFenceLike;
  /** Durable object roots vs. the paths the database records; absent when nothing is configured. */
  readonly objectRoots?: { check(): Promise<{ readonly ok: boolean; readonly detail: string }> };
  readonly expectedSchemaVersion?: number;
}

export async function readinessReport(inputs: ReadinessInputs): Promise<ReadinessReport> {
  const expectedSchemaVersion = inputs.expectedSchemaVersion ?? EXPECTED_SCHEMA_VERSION;
  const checks: ReadinessCheck[] = [];
  let schemaVersion = 0;
  let controlPlaneOk = false;

  if (!inputs.database) {
    checks.push({ name: 'database', ok: false, detail: 'no PostgreSQL control plane configured' });
  } else {
    try {
      const result = await inputs.database.query<{ version: number | null }>(
        'SELECT max(version) AS version FROM schema_migrations'
      );
      schemaVersion = result.rows[0]?.version ?? 0;
      checks.push({ name: 'database', ok: true, detail: 'PostgreSQL reachable' });
      const schemaOk = schemaVersion === expectedSchemaVersion;
      checks.push({
        name: 'schema',
        ok: schemaOk,
        detail: schemaOk
          ? `schema version ${schemaVersion} matches this build`
          : `schema version ${schemaVersion} does not match the expected ${expectedSchemaVersion}; apply pending migrations before serving`,
      });
      controlPlaneOk = schemaOk;
    } catch (error) {
      checks.push({ name: 'database', ok: false, detail: `PostgreSQL query failed: ${(error as Error).message}` });
    }
  }

  const gatewayReady = inputs.executionGateway?.isReady() === true;
  checks.push({
    name: 'executionGateway',
    ok: gatewayReady,
    detail: gatewayReady
      ? 'native gateway is running; a worker must still connect and claim work'
      : inputs.executionGateway
        ? 'native gateway is configured but not ready'
        : 'no native gateway configured: nothing can dispatch sandboxed work',
  });

  checks.push({
    name: 'executionPlane',
    ok: !inputs.devExecutorEnabled,
    detail: inputs.devExecutorEnabled
      ? 'OANTUTI_DEV_EXECUTION=1 arms the unsandboxed development executor: student code would run in this process'
      : 'development executor is off',
  });

  if (!inputs.backupFence) {
    checks.push({ name: 'backupFence', ok: false, detail: 'no backup freshness fence configured' });
  } else {
    const fence = await inputs.backupFence.status();
    const fresh = fence.enforced && !fence.stale;
    checks.push({
      name: 'backupFence',
      ok: fresh,
      detail: fence.enforced
        ? fence.stale
          ? `backup checkpoint is stale (lag ${fence.lagMinutes === null ? 'unknown' : `${fence.lagMinutes}m`}, max ${fence.maxLagMinutes}m)`
          : `backup checkpoint fresh within ${fence.maxLagMinutes}m`
        : 'backup freshness is not enforced (OANTUTI_BACKUP_FENCE=off)',
    });
  }

  if (inputs.objectRoots) {
    const roots = await inputs.objectRoots.check();
    checks.push({ name: 'objectRoots', ok: roots.ok, detail: roots.detail });
  }

  const nativeCapabilities = gatewayReady && inputs.executionGateway?.capabilities
    ? await inputs.executionGateway.capabilities()
    : { officialGame: false, build: false, privateTest: false };
  const accepts: ReadinessAccepts = inputs.devExecutorEnabled
    ? { officialGame: true, build: true, privateTest: true }
    : nativeCapabilities;
  checks.push({ name: 'workers', ok: accepts.officialGame && accepts.build && accepts.privateTest && !inputs.devExecutorEnabled,
    detail: !inputs.devExecutorEnabled && accepts.officialGame && accepts.build && accepts.privateTest
      ? 'authenticated native workers offer game and build slots' : 'no complete authenticated native worker capacity' });

  const status = controlPlaneOk && checks.every((check) => check.ok) ? 'ready' : 'degraded';

  return {
    status,
    productionReady: status === 'ready' && !inputs.devExecutorEnabled,
    accepts,
    checks,
    schemaVersion,
    expectedSchemaVersion,
    timestamp: new Date().toISOString(),
  };
}
