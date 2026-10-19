/**
 * Retention & purge service (S15 partial).
 *
 * Technical defaults come from `05-SECURITY-OPERATIONS-QUALITY.md` §7/§4.3:
 *   operational logs 30d · private diagnostics 30d after finalize ·
 *   private TEST evidence (snapshots/results/replay/logs) 7d from terminal ·
 *   abandoned staging 24h when no job references it ·
 *   security/admin audit 1 year · official source/evidence 90d after finalize ·
 *   official ledger/replay at least 1 year · backup 35d.
 *
 * The application role may only DELETE the classes it owns; audit rows are
 * reported but never purged here (the DB role has no DELETE grant), and
 * official source/ledger purges stay with the operator runbook so nothing is
 * silently destroyed. Holds (global/tournament/team) always win over TTL.
 */
import { randomUUID } from 'node:crypto';
import type { CommandContext } from '@oantuti/protocol';
import type { PostgresDatabase } from '../persistence/db.js';

export class RetentionError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = 'RetentionError';
  }
}

export const RETENTION_POLICY = {
  operationalLogsDays: 30,
  privateDiagnosticsDaysAfterFinalize: 30,
  testEvidenceDaysAfterTerminal: 7,
  abandonedStagingHours: 24,
  securityAdminAuditDays: 365,
  officialSourceDaysAfterFinalize: 90,
  officialReplayMinimumDays: 365,
  backupDays: 35,
} as const;

export const RETENTION_HOLDS_KEY = 'retention_holds';

export interface RetentionHold {
  readonly scope: 'GLOBAL' | 'TOURNAMENT' | 'TEAM';
  readonly id?: string;
  readonly reason: string;
  readonly createdAt: string;
}

export type RetentionClassAction =
  | 'DELETE_ROW'
  | 'NULL_DIAGNOSTICS'
  | 'DELETE_DELIVERED_OUTBOX'
  | 'DELETE_TERMINAL_JOB'
  | 'REPORT_ONLY';

export interface RetentionClassReport {
  readonly className: string;
  readonly action: RetentionClassAction;
  readonly description: string;
  readonly ttl: string;
  readonly rows: number;
  readonly bytes: number;
  readonly oldest: string | null;
  readonly purgeableRows: number;
  readonly purgeableBytes: number;
  readonly heldRows: number;
  readonly appPurgeAllowed: boolean;
}

export interface RetentionReport {
  readonly generatedAt: string;
  readonly policies: typeof RETENTION_POLICY;
  readonly holds: { readonly configured: readonly RetentionHold[]; readonly activeDisputes: number };
  readonly classes: readonly RetentionClassReport[];
}

export interface RetentionSweepAction {
  readonly className: string;
  readonly action: RetentionClassAction;
  readonly rows: number;
  readonly bytes: number;
  readonly skippedHeld: number;
}

export interface RetentionSweepResult {
  readonly dryRun: boolean;
  readonly generatedAt: string;
  readonly actions: readonly RetentionSweepAction[];
}

interface TestSnapshotRow {
  readonly id: string;
  readonly tournament_id: string;
  readonly team_id: string;
  readonly status: string;
  readonly completed_at: string | null;
  readonly created_at: string;
  readonly replay_digest: string | null;
  readonly replay_bytes: number | null;
  readonly diagnostics_present: boolean;
}

const TERMINAL_TEST_STATUSES = ['COMPLETED', 'FAILED'];
const ACTIVE_JOB_STATES = ['QUEUED', 'LEASED', 'RUNNING', 'COMPLETION_PENDING'];

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

/** pg returns timestamptz as Date; normalize so TTL comparisons never hit string coercion. */
function epoch(value: string | Date | null | undefined): number {
  if (!value) return 0;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * SQL form of {@link RetentionService.isHeld}, over the holds array bound as `$2::jsonb` against a
 * `test_snapshots ts` alias. Kept next to the class so the destructive diagnostics pass and the
 * operator-facing count can never disagree about what "held" means.
 */
const NOT_HELD_PREDICATE = `NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements($2::jsonb) AS hold
            WHERE hold->>'scope' = 'GLOBAL'
               OR (hold->>'scope' = 'TOURNAMENT' AND hold->>'id' = ts.tournament_id::text)
               OR (hold->>'scope' = 'TEAM' AND hold->>'id' = ts.team_id::text))`;

export class RetentionService {
  constructor(private readonly db: PostgresDatabase) {}

  private requireAdmin(ctx: CommandContext, action: string): void {
    if (ctx.actor.role !== 'ADMIN') {
      throw new RetentionError(403, `Only administrators can ${action}`);
    }
  }

  private normalizeHolds(raw: unknown): RetentionHold[] {
    if (!Array.isArray(raw)) return [];
    const holds: RetentionHold[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const candidate = entry as Partial<RetentionHold>;
      if (candidate.scope !== 'GLOBAL' && candidate.scope !== 'TOURNAMENT' && candidate.scope !== 'TEAM') continue;
      if (candidate.scope !== 'GLOBAL' && (typeof candidate.id !== 'string' || candidate.id.trim() === '')) continue;
      holds.push({
        scope: candidate.scope,
        id: candidate.id,
        reason: typeof candidate.reason === 'string' && candidate.reason.trim() !== '' ? candidate.reason : 'no reason given',
        createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : new Date().toISOString(),
      });
    }
    return holds;
  }

  async listHolds(): Promise<RetentionHold[]> {
    const res = await this.db.query<{ value: unknown }>(
      'SELECT value FROM deployment_settings WHERE key = $1',
      [RETENTION_HOLDS_KEY]
    );
    return this.normalizeHolds(res.rows[0]?.value);
  }

  async replaceHolds(holds: readonly RetentionHold[], ctx: CommandContext): Promise<RetentionHold[]> {
    this.requireAdmin(ctx, 'change retention holds');
    const normalized = this.normalizeHolds(holds);
    await this.db.query(
      `INSERT INTO deployment_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [RETENTION_HOLDS_KEY, JSON.stringify(normalized)]
    );
    await this.db.query(
      `INSERT INTO audit_events (actor_user_id, action, resource_type, resource_id, request_id, details)
       VALUES ($1, 'RETENTION_HOLDS_UPDATED', 'deployment_settings', $2, $3, $4)`,
      [ctx.actor.userId, RETENTION_HOLDS_KEY, randomUUID(), JSON.stringify({ holds: normalized })]
    );
    return normalized;
  }

  private isHeld(holds: readonly RetentionHold[], tournamentId: string, teamId: string): boolean {
    return holds.some((hold) => {
      if (hold.scope === 'GLOBAL') return true;
      if (hold.scope === 'TOURNAMENT') return hold.id === tournamentId;
      return hold.id === teamId;
    });
  }

  private async loadTestSnapshots(): Promise<TestSnapshotRow[]> {
    const res = await this.db.query<TestSnapshotRow>(
      `SELECT ts.id,
              ts.tournament_id,
              ts.team_id,
              ts.status,
              ts.completed_at,
              ts.created_at,
              ts.replay_digest,
              ro.size_bytes AS replay_bytes,
              (ts.build_logs IS NOT NULL OR ts.execution_logs IS NOT NULL OR ts.private_trace IS NOT NULL) AS diagnostics_present
         FROM test_snapshots ts
         LEFT JOIN replay_objects ro ON ro.digest = ts.replay_digest`
    );
    return res.rows;
  }

  private async activeDisputeCount(): Promise<number> {
    const res = await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM disputes WHERE status IN ('OPEN', 'UNDER_REVIEW')`
    );
    return Number(res.rows[0]?.count ?? 0);
  }

  async report(ctx: CommandContext): Promise<RetentionReport> {
    this.requireAdmin(ctx, 'read the retention report');
    const holds = await this.listHolds();
    const snapshots = await this.loadTestSnapshots();
    const terminalCutoff = epoch(isoDaysAgo(RETENTION_POLICY.testEvidenceDaysAfterTerminal));
    const stagingCutoff = epoch(isoHoursAgo(RETENTION_POLICY.abandonedStagingHours));
    const diagnosticsCutoff = isoDaysAgo(RETENTION_POLICY.privateDiagnosticsDaysAfterFinalize);
    const logsCutoff = isoDaysAgo(RETENTION_POLICY.operationalLogsDays);
    const auditCutoff = isoDaysAgo(RETENTION_POLICY.securityAdminAuditDays);
    const replayCutoff = isoDaysAgo(RETENTION_POLICY.officialReplayMinimumDays);

    const abandonedJobs = await this.db.query<{ target_id: string }>(
      `SELECT DISTINCT target_id FROM jobs WHERE job_type IN ('TEST_BUILD', 'TEST_GAME') AND state = ANY($1::text[])`,
      [ACTIVE_JOB_STATES]
    );
    const referencedTargets = new Set(abandonedJobs.rows.map((row) => row.target_id));

    const terminal = snapshots.filter(
      (snap) => TERMINAL_TEST_STATUSES.includes(snap.status) && epoch(snap.completed_at ?? snap.created_at) < terminalCutoff
    );
    const staging = snapshots.filter(
      (snap) =>
        !TERMINAL_TEST_STATUSES.includes(snap.status) &&
        epoch(snap.created_at) < stagingCutoff &&
        !referencedTargets.has(snap.id)
    );
    const terminalHeld = terminal.filter((snap) => this.isHeld(holds, snap.tournament_id, snap.team_id));
    const stagingHeld = staging.filter((snap) => this.isHeld(holds, snap.tournament_id, snap.team_id));

    const testBytes = (rows: readonly TestSnapshotRow[]): number =>
      rows.reduce((sum, row) => sum + (row.replay_bytes ?? 0), 0);

    const diagnostics = await this.db.query<{ rows: string; bytes: string; oldest: string | null; held: string }>(
      `SELECT count(*)::text AS rows,
              coalesce(sum(coalesce(ro.size_bytes, 0)), 0)::text AS bytes,
              min(ts.created_at)::text AS oldest,
              count(*) FILTER (WHERE NOT (${NOT_HELD_PREDICATE}))::text AS held
         FROM test_snapshots ts
         JOIN tournaments t ON t.id = ts.tournament_id
         LEFT JOIN replay_objects ro ON ro.digest = ts.replay_digest
        WHERE t.finalized_at IS NOT NULL
          AND t.finalized_at < $1::timestamptz
          AND (ts.build_logs IS NOT NULL OR ts.execution_logs IS NOT NULL OR ts.private_trace IS NOT NULL)`,
      [diagnosticsCutoff, JSON.stringify(holds)]
    );

    const outbox = await this.db.query<{ rows: string; bytes: string; oldest: string | null }>(
      `SELECT count(*)::text AS rows,
              coalesce(sum(length(payload::text)), 0)::text AS bytes,
              min(created_at)::text AS oldest
         FROM outbox_events
        WHERE delivered_at IS NOT NULL AND delivered_at < $1::timestamptz`,
      [logsCutoff]
    );

    const jobs = await this.db.query<{ rows: string; oldest: string | null }>(
      `SELECT count(*)::text AS rows, min(updated_at)::text AS oldest
         FROM jobs
        WHERE state IN ('SUCCEEDED', 'BLOCKED') AND updated_at < $1::timestamptz`,
      [logsCutoff]
    );

    const audit = await this.db.query<{ rows: string; oldest: string | null }>(
      `SELECT count(*)::text AS rows, min(created_at)::text AS oldest FROM audit_events WHERE created_at < $1::timestamptz`,
      [auditCutoff]
    );

    const officialSource = await this.db.query<{ rows: string; bytes: string; oldest: string | null }>(
      `SELECT count(*)::text AS rows,
              coalesce(sum(ss.zip_bytes), 0)::text AS bytes,
              min(ss.created_at)::text AS oldest
         FROM submission_sources ss
        WHERE ss.created_at < $1::timestamptz
          AND NOT EXISTS (
            SELECT 1 FROM tournaments t
             WHERE t.finalized_at IS NULL
               AND (t.id IN (SELECT tournament_id FROM submissions s WHERE s.source_digest = ss.digest)
                    OR t.id IN (SELECT tournament_id FROM test_snapshots ts WHERE ts.source_digest = ss.digest))
          )`,
      [isoDaysAgo(RETENTION_POLICY.officialSourceDaysAfterFinalize)]
    );

    const orphanReplays = await this.db.query<{ rows: string; bytes: string; oldest: string | null }>(
      `SELECT count(*)::text AS rows,
              coalesce(sum(ro.size_bytes), 0)::text AS bytes,
              min(ro.created_at)::text AS oldest
         FROM replay_objects ro
        WHERE ro.created_at < $1::timestamptz
          AND NOT EXISTS (SELECT 1 FROM result_versions rv WHERE rv.replay_digest = ro.digest)`,
      [replayCutoff]
    );

    const classes: RetentionClassReport[] = [
      {
        className: 'PRIVATE_TEST_EVIDENCE',
        action: 'DELETE_ROW',
        description: 'Private TEST snapshots, results, replay objects and logs after the terminal state.',
        ttl: `${RETENTION_POLICY.testEvidenceDaysAfterTerminal}d from terminal`,
        rows: terminal.length,
        bytes: testBytes(terminal),
        oldest: terminal.length ? (terminal.map((r) => r.completed_at ?? r.created_at).sort()[0] ?? null) : null,
        purgeableRows: terminal.length - terminalHeld.length,
        purgeableBytes: testBytes(terminal.filter((row) => !this.isHeld(holds, row.tournament_id, row.team_id))),
        heldRows: terminalHeld.length,
        appPurgeAllowed: true,
      },
      {
        className: 'ABANDONED_STAGING',
        action: 'DELETE_ROW',
        description: 'Non-terminal private TEST staging with no job referencing it.',
        ttl: `${RETENTION_POLICY.abandonedStagingHours}h from creation`,
        rows: staging.length,
        bytes: testBytes(staging),
        oldest: staging.length ? (staging.map((r) => r.created_at).sort()[0] ?? null) : null,
        purgeableRows: staging.length - stagingHeld.length,
        purgeableBytes: testBytes(staging.filter((row) => !this.isHeld(holds, row.tournament_id, row.team_id))),
        heldRows: stagingHeld.length,
        appPurgeAllowed: true,
      },
      {
        className: 'PRIVATE_DIAGNOSTICS',
        action: 'NULL_DIAGNOSTICS',
        description: 'Build/execution logs and private traces for tournaments finalized long ago.',
        ttl: `${RETENTION_POLICY.privateDiagnosticsDaysAfterFinalize}d after finalize`,
        rows: Number(diagnostics.rows[0]?.rows ?? 0),
        bytes: Number(diagnostics.rows[0]?.bytes ?? 0),
        oldest: diagnostics.rows[0]?.oldest ?? null,
        purgeableRows: Number(diagnostics.rows[0]?.rows ?? 0) - Number(diagnostics.rows[0]?.held ?? 0),
        purgeableBytes: Number(diagnostics.rows[0]?.bytes ?? 0),
        heldRows: Number(diagnostics.rows[0]?.held ?? 0),
        appPurgeAllowed: true,
      },
      {
        className: 'OPERATIONAL_OUTBOX',
        action: 'DELETE_DELIVERED_OUTBOX',
        description: 'Delivered outbox events past the operational log window.',
        ttl: `${RETENTION_POLICY.operationalLogsDays}d`,
        rows: Number(outbox.rows[0]?.rows ?? 0),
        bytes: Number(outbox.rows[0]?.bytes ?? 0),
        oldest: outbox.rows[0]?.oldest ?? null,
        purgeableRows: Number(outbox.rows[0]?.rows ?? 0),
        purgeableBytes: Number(outbox.rows[0]?.bytes ?? 0),
        heldRows: 0,
        appPurgeAllowed: true,
      },
      {
        className: 'OPERATIONAL_JOBS',
        action: 'DELETE_TERMINAL_JOB',
        description: 'Succeeded/blocked jobs past the operational log window (attempts and completions cascade).',
        ttl: `${RETENTION_POLICY.operationalLogsDays}d`,
        rows: Number(jobs.rows[0]?.rows ?? 0),
        bytes: 0,
        oldest: jobs.rows[0]?.oldest ?? null,
        purgeableRows: Number(jobs.rows[0]?.rows ?? 0),
        purgeableBytes: 0,
        heldRows: 0,
        appPurgeAllowed: true,
      },
      {
        className: 'SECURITY_ADMIN_AUDIT',
        action: 'REPORT_ONLY',
        description: 'Audit trail past one year; the application role has no DELETE grant, operators purge through the runbook.',
        ttl: `${RETENTION_POLICY.securityAdminAuditDays}d`,
        rows: Number(audit.rows[0]?.rows ?? 0),
        bytes: 0,
        oldest: audit.rows[0]?.oldest ?? null,
        purgeableRows: 0,
        purgeableBytes: 0,
        heldRows: 0,
        appPurgeAllowed: false,
      },
      {
        className: 'OFFICIAL_SOURCE',
        action: 'REPORT_ONLY',
        description: 'Official submission sources older than the post-finalize window; operator-approved archive/purge only.',
        ttl: `${RETENTION_POLICY.officialSourceDaysAfterFinalize}d after finalize`,
        rows: Number(officialSource.rows[0]?.rows ?? 0),
        bytes: Number(officialSource.rows[0]?.bytes ?? 0),
        oldest: officialSource.rows[0]?.oldest ?? null,
        purgeableRows: 0,
        purgeableBytes: 0,
        heldRows: 0,
        appPurgeAllowed: false,
      },
      {
        className: 'OFFICIAL_REPLAY',
        action: 'REPORT_ONLY',
        description: 'Replay objects past the one-year floor and unreferenced by any accepted result.',
        ttl: `>=${RETENTION_POLICY.officialReplayMinimumDays}d`,
        rows: Number(orphanReplays.rows[0]?.rows ?? 0),
        bytes: Number(orphanReplays.rows[0]?.bytes ?? 0),
        oldest: orphanReplays.rows[0]?.oldest ?? null,
        purgeableRows: 0,
        purgeableBytes: 0,
        heldRows: 0,
        appPurgeAllowed: false,
      },
    ];

    return {
      generatedAt: new Date().toISOString(),
      policies: RETENTION_POLICY,
      holds: { configured: holds, activeDisputes: await this.activeDisputeCount() },
      classes,
    };
  }

  async sweep(input: { readonly dryRun?: boolean }, ctx: CommandContext): Promise<RetentionSweepResult> {
    this.requireAdmin(ctx, 'run a retention sweep');
    return this.runSweep(input.dryRun !== false, ctx.actor.userId);
  }

  /**
   * Sweep driven by the worker instead of an operator. Retention is a TTL duty: nothing about it
   * needs a human, and a store nobody sweeps silently breaks the retention inventory. The audit row
   * records a null actor to mark the sweep as automatic, and this entry point is deliberately not
   * exposed through any route.
   */
  async sweepAsSystem(dryRun = false): Promise<RetentionSweepResult> {
    return this.runSweep(dryRun, null);
  }

  private async runSweep(dryRun: boolean, actorUserId: string | null): Promise<RetentionSweepResult> {
    const holds = await this.listHolds();
    const snapshots = await this.loadTestSnapshots();
    const terminalCutoff = epoch(isoDaysAgo(RETENTION_POLICY.testEvidenceDaysAfterTerminal));
    const stagingCutoff = epoch(isoHoursAgo(RETENTION_POLICY.abandonedStagingHours));
    const diagnosticsCutoff = isoDaysAgo(RETENTION_POLICY.privateDiagnosticsDaysAfterFinalize);
    const logsCutoff = isoDaysAgo(RETENTION_POLICY.operationalLogsDays);

    const abandonedJobs = await this.db.query<{ target_id: string }>(
      `SELECT DISTINCT target_id FROM jobs WHERE job_type IN ('TEST_BUILD', 'TEST_GAME') AND state = ANY($1::text[])`,
      [ACTIVE_JOB_STATES]
    );
    const referencedTargets = new Set(abandonedJobs.rows.map((row) => row.target_id));

    const eligibleByTtl = snapshots.filter((snap) => {
      if (TERMINAL_TEST_STATUSES.includes(snap.status)) {
        return epoch(snap.completed_at ?? snap.created_at) < terminalCutoff;
      }
      return epoch(snap.created_at) < stagingCutoff && !referencedTargets.has(snap.id);
    });
    const deletable = eligibleByTtl.filter((snap) => !this.isHeld(holds, snap.tournament_id, snap.team_id));
    const skippedHeld = eligibleByTtl.length - deletable.length;
    const replayCandidates = [...new Set(deletable.map((snap) => snap.replay_digest).filter((d): d is string => !!d))];

    const actions: RetentionSweepAction[] = [];
    let deletedSnapshots = 0;
    let deletedReplays = 0;
    let replayBytes = 0;
    let nulledDiagnostics = 0;
    let deletedOutbox = 0;
    let deletedJobs = 0;

    if (!dryRun) {
      const result = await this.db.withTransaction(async (client) => {
        let snapshotsDeleted = 0;
        if (deletable.length > 0) {
          const res = await client.query(
            `DELETE FROM test_snapshots WHERE id = ANY($1::uuid[])`,
            [deletable.map((snap) => snap.id)]
          );
          snapshotsDeleted = res.rowCount ?? 0;
        }

        const replayDigests: string[] = [];
        for (const digest of replayCandidates) {
          const ref = await client.query<{ count: string }>(
            `SELECT (
                (SELECT count(*) FROM result_versions WHERE replay_digest = $1) +
                (SELECT count(*) FROM test_snapshots WHERE replay_digest = $1)
             )::text AS count`,
            [digest]
          );
          if (Number(ref.rows[0]?.count ?? 0) === 0) replayDigests.push(digest);
        }
        let replayRows = 0;
        let replaySize = 0;
        if (replayDigests.length > 0) {
          const size = await client.query<{ bytes: string }>(
            `SELECT coalesce(sum(size_bytes), 0)::text AS bytes FROM replay_objects WHERE digest = ANY($1::text[])`,
            [replayDigests]
          );
          const res = await client.query(`DELETE FROM replay_objects WHERE digest = ANY($1::text[])`, [replayDigests]);
          replayRows = res.rowCount ?? 0;
          replaySize = Number(size.rows[0]?.bytes ?? 0);
        }

        // Holds beat TTL for diagnostics too: a tournament or team under a hold keeps the private
        // logs and traces a late appeal or a security review may need.
        const diag = await client.query(
          `UPDATE test_snapshots ts
              SET build_logs = NULL, execution_logs = NULL, private_trace = NULL
             FROM tournaments t
            WHERE t.id = ts.tournament_id
              AND t.finalized_at IS NOT NULL
              AND t.finalized_at < $1::timestamptz
              AND (ts.build_logs IS NOT NULL OR ts.execution_logs IS NOT NULL OR ts.private_trace IS NOT NULL)
              AND ${NOT_HELD_PREDICATE}`,
          [diagnosticsCutoff, JSON.stringify(holds)]
        );

        const outboxRes = await client.query(
          `DELETE FROM outbox_events WHERE delivered_at IS NOT NULL AND delivered_at < $1::timestamptz`,
          [logsCutoff]
        );
        const jobRes = await client.query(
          `DELETE FROM jobs WHERE state IN ('SUCCEEDED', 'BLOCKED') AND updated_at < $1::timestamptz`,
          [logsCutoff]
        );

        await client.query(
          `INSERT INTO audit_events (actor_user_id, action, resource_type, resource_id, request_id, details)
           VALUES ($1, 'RETENTION_SWEEP', 'deployment_settings', 'retention', $2, $3)`,
          [
            actorUserId,
            randomUUID(),
            JSON.stringify({
              dryRun: false,
              testSnapshots: snapshotsDeleted,
              replayObjects: replayRows,
              diagnosticsNulled: diag.rowCount ?? 0,
              outboxDeleted: outboxRes.rowCount ?? 0,
              jobsDeleted: jobRes.rowCount ?? 0,
            }),
          ]
        );

        return {
          snapshotsDeleted,
          replayRows,
          replaySize,
          diagnosticsNulled: diag.rowCount ?? 0,
          outboxDeleted: outboxRes.rowCount ?? 0,
          jobsDeleted: jobRes.rowCount ?? 0,
        };
      });
      deletedSnapshots = result.snapshotsDeleted;
      deletedReplays = result.replayRows;
      replayBytes = result.replaySize;
      nulledDiagnostics = result.diagnosticsNulled;
      deletedOutbox = result.outboxDeleted;
      deletedJobs = result.jobsDeleted;
    }

    const plannedSnapshots = dryRun ? deletable.length : deletedSnapshots;
    const plannedReplayCount = dryRun ? replayCandidates.length : deletedReplays;
    const plannedReplayBytes = dryRun
      ? replayCandidates.reduce((sum, digest) => {
          const snap = snapshots.find((row) => row.replay_digest === digest && row.replay_bytes !== null);
          return sum + (snap?.replay_bytes ?? 0);
        }, 0)
      : replayBytes;
    const plannedDiagnostics = dryRun
      ? Number(
          (
            await this.db.query<{ rows: string }>(
              `SELECT count(*)::text AS rows
                 FROM test_snapshots ts JOIN tournaments t ON t.id = ts.tournament_id
                WHERE t.finalized_at IS NOT NULL AND t.finalized_at < $1::timestamptz
                  AND (ts.build_logs IS NOT NULL OR ts.execution_logs IS NOT NULL OR ts.private_trace IS NOT NULL)`,
              [diagnosticsCutoff]
            )
          ).rows[0]?.rows ?? 0
        )
      : nulledDiagnostics;
    const plannedOutbox = dryRun
      ? Number(
          (
            await this.db.query<{ rows: string }>(
              `SELECT count(*)::text AS rows FROM outbox_events WHERE delivered_at IS NOT NULL AND delivered_at < $1::timestamptz`,
              [logsCutoff]
            )
          ).rows[0]?.rows ?? 0
        )
      : deletedOutbox;
    const plannedJobs = dryRun
      ? Number(
          (
            await this.db.query<{ rows: string }>(
              `SELECT count(*)::text AS rows FROM jobs WHERE state IN ('SUCCEEDED', 'BLOCKED') AND updated_at < $1::timestamptz`,
              [logsCutoff]
            )
          ).rows[0]?.rows ?? 0
        )
      : deletedJobs;

    actions.push(
      {
        className: 'PRIVATE_TEST_EVIDENCE',
        action: 'DELETE_ROW',
        rows: plannedSnapshots,
        bytes: 0,
        skippedHeld: skippedHeld,
      },
      {
        className: 'PRIVATE_TEST_REPLAY_OBJECTS',
        action: 'DELETE_ROW',
        rows: plannedReplayCount,
        bytes: plannedReplayBytes,
        skippedHeld: 0,
      },
      {
        className: 'PRIVATE_DIAGNOSTICS',
        action: 'NULL_DIAGNOSTICS',
        rows: plannedDiagnostics,
        bytes: 0,
        skippedHeld: 0,
      },
      {
        className: 'OPERATIONAL_OUTBOX',
        action: 'DELETE_DELIVERED_OUTBOX',
        rows: plannedOutbox,
        bytes: 0,
        skippedHeld: 0,
      },
      {
        className: 'OPERATIONAL_JOBS',
        action: 'DELETE_TERMINAL_JOB',
        rows: plannedJobs,
        bytes: 0,
        skippedHeld: 0,
      }
    );

    return { dryRun, generatedAt: new Date().toISOString(), actions };
  }
}
