import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { JobBroker } from '../jobs/broker.js';
import type { BackupFence } from '../operations/backup-fence.js';
import type { Database } from '../persistence/db.js';
import type { ArtifactStore } from './artifact-store.js';
import type {
  Actor,
  BotLanguage,
  Digest,
  Instant,
  PrivateSourceDto,
  SubmissionDto,
  SubmissionReceipt,
  SubmissionStatus,
  TestReceipt,
  TestSnapshotDto,
  UUID,
} from '@oantuti/protocol';
import { auditRequestId } from '../persistence/audit-request-id.js';

export class SubmissionError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    /** Machine-readable error code surfaced verbatim in the HTTP error body. */
    readonly code?: string,
    /** Structured context (e.g. which quota tripped) surfaced as `details` in the HTTP error body. */
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'SubmissionError';
  }
}

/**
 * S05 designer-default quota policy, scoped per (tournament, team).
 * Limits live here so the intent and the numbers stay in one place.
 */
const QUOTA_POLICY = {
  officialHourly: 10,
  officialDaily: 100,
  officialPendingCompiles: 2,
  testPending: 2,
  testDaily: 30,
  testCreatePerMinute: 10,
} as const;

/**
 * `submissions.status` values that mean the receipt is still being compiled/validated and has
 * not reached a terminal state yet. Intake inserts 'VALIDATING' and the build pipeline walks
 * the receipt through COMPILING/SMOKE_TESTING to READY or REJECTED, so a receipt in flight
 * keeps its (tournament, team) slot against the PENDING_COMPILES quota for its whole build.
 */
const PENDING_SUBMISSION_STATUSES = ['VALIDATING', 'QUEUED', 'COMPILING', 'SMOKE_TESTING'] as const;

/**
 * `test_snapshots.status` values for a run that is queued, building or executing. The build
 * pipeline walks QUEUED → COMPILING → SMOKE_TESTING → COMPLETED/FAILED, so the intermediate
 * states count against the pending-test quota exactly like they do for submissions.
 */
const PENDING_TEST_STATUSES = ['QUEUED', 'COMPILING', 'SMOKE_TESTING', 'RUNNING'] as const;

/**
 * Priority of a receipt/snapshot build job. Above GAME (100) so that, if a worker ever claims
 * builds and games in the same slot offer, verifying a receipt wins over playing with it.
 */
const BUILD_JOB_PRIORITY = 150;

interface SubmissionRow {
  readonly id: string;
  readonly tournament_id: string;
  readonly team_id: string;
  readonly submitted_by_user_id: string;
  readonly receipt_ordinal: number;
  readonly source_digest: string;
  readonly language: BotLanguage;
  readonly entrypoint: string;
  readonly status: 'VALIDATING' | 'QUEUED' | 'COMPILING' | 'SMOKE_TESTING' | 'READY' | 'REJECTED';
  readonly reject_reason: string | null;
  readonly received_at: Date;
  readonly created_at: Date;
}

interface SubmissionHistoryRow {
  readonly id: string;
  readonly receipt_ordinal: number;
  readonly source_digest: string;
  readonly language: BotLanguage;
  readonly entrypoint: string;
  readonly status: SubmissionStatus;
  readonly created_at: Date;
}

/** Team-scoped submission history entry as exposed by the read API. */
export interface SubmissionHistoryItem {
  readonly id: UUID;
  readonly receiptOrdinal: number;
  readonly language: BotLanguage;
  readonly entrypoint: string;
  readonly sourceDigest: Digest;
  readonly status: SubmissionStatus;
  readonly createdAt: Instant;
}

interface TournamentCheckRow {
  readonly id: string;
  readonly state: string;
  readonly registration_closes_at: Date | null;
}

export class SubmissionService {
  constructor(
    private readonly db: Database,
    private readonly artifactStore: ArtifactStore,
    /** Durable queue the BUILD/TEST_BUILD job for every accepted receipt is enqueued on. */
    private readonly jobBroker: JobBroker,
    /** Protected-write fence: refuses a new receipt while the backup heartbeat is stale. */
    private readonly backupFence?: BackupFence
  ) {}

  private checkActorTeam(teamId: UUID, actor: Actor): void {
    if (actor.scope !== 'FULL') {
      throw new SubmissionError(403, 'Session requires full scope to submit code');
    }
    if (actor.role === 'ADMIN') return;
    if (!actor.teamIds.includes(teamId)) {
      throw new SubmissionError(403, 'Forbidden: You do not belong to this team');
    }
  }

  /**
   * S05 official-receipt quota gate for one (tournament, team).
   * MUST run inside the same transaction that assigns `receipt_ordinal` so a
   * concurrent burst cannot overshoot: the tournament row is locked `FOR UPDATE`
   * before this call, serializing receipts within a tournament.
   * Windows: rolling 60 minutes and the current UTC calendar day, both keyed on
   * `submissions.received_at` (the intake timestamp).
   */
  private async assertOfficialQuota(client: PoolClient, tournamentId: UUID, teamId: UUID): Promise<void> {
    const hourly = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM submissions
       WHERE tournament_id = $1 AND team_id = $2
         AND received_at > clock_timestamp() - INTERVAL '60 minutes'`,
      [tournamentId, teamId]
    );
    if (parseInt(hourly.rows[0].count, 10) >= QUOTA_POLICY.officialHourly) {
      throw new SubmissionError(
        429,
        `Official receipt quota exceeded: max ${QUOTA_POLICY.officialHourly} per rolling 60 minutes`,
        'QUOTA_EXCEEDED',
        { quota: 'RECEIPTS_HOURLY', limit: QUOTA_POLICY.officialHourly, windowSeconds: 3600 }
      );
    }

    // `clock_timestamp() AT TIME ZONE 'UTC'` pins the boundary to UTC midnight
    // regardless of the session TimeZone, then converts back to timestamptz.
    const daily = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM submissions
       WHERE tournament_id = $1 AND team_id = $2
         AND received_at >= (date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`,
      [tournamentId, teamId]
    );
    if (parseInt(daily.rows[0].count, 10) >= QUOTA_POLICY.officialDaily) {
      throw new SubmissionError(
        429,
        `Daily receipt quota exceeded: max ${QUOTA_POLICY.officialDaily} per UTC day`,
        'QUOTA_EXCEEDED',
        { quota: 'RECEIPTS_DAILY', limit: QUOTA_POLICY.officialDaily }
      );
    }

    const pending = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM submissions
       WHERE tournament_id = $1 AND team_id = $2 AND status = ANY($3::text[])`,
      [tournamentId, teamId, [...PENDING_SUBMISSION_STATUSES]]
    );
    if (parseInt(pending.rows[0].count, 10) >= QUOTA_POLICY.officialPendingCompiles) {
      throw new SubmissionError(
        429,
        `Pending compile quota exceeded: max ${QUOTA_POLICY.officialPendingCompiles} receipts in flight`,
        'QUOTA_EXCEEDED',
        { quota: 'PENDING_COMPILES', limit: QUOTA_POLICY.officialPendingCompiles }
      );
    }
  }

  /**
   * S05 private-TEST quota gate for one (tournament, team).
   * Windows: in-flight runs (QUEUED/RUNNING, unbounded by time) and the current
   * UTC calendar day keyed on `test_snapshots.created_at`.
   */
  private async assertTestQuota(client: PoolClient, tournamentId: UUID, teamId: UUID): Promise<void> {
    const pending = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM test_snapshots
       WHERE tournament_id = $1 AND team_id = $2 AND status = ANY($3::text[])`,
      [tournamentId, teamId, [...PENDING_TEST_STATUSES]]
    );
    if (parseInt(pending.rows[0].count, 10) >= QUOTA_POLICY.testPending) {
      throw new SubmissionError(
        429,
        `Private test quota exceeded: max ${QUOTA_POLICY.testPending} pending runs`,
        'QUOTA_EXCEEDED',
        { quota: 'TEST_PENDING', limit: QUOTA_POLICY.testPending }
      );
    }

    const daily = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM test_snapshots
       WHERE tournament_id = $1 AND team_id = $2
         AND created_at >= (date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`,
      [tournamentId, teamId]
    );
    if (parseInt(daily.rows[0].count, 10) >= QUOTA_POLICY.testDaily) {
      throw new SubmissionError(
        429,
        `Daily private test quota exceeded: max ${QUOTA_POLICY.testDaily} per UTC day`,
        'QUOTA_EXCEEDED',
        { quota: 'TEST_DAILY', limit: QUOTA_POLICY.testDaily }
      );
    }
  }

  /**
   * S05 private-TEST create-request window: 10 requests per rolling minute per (tournament, team).
   *
   * Callers record the attempt **before** validating the payload so a rejected request still consumes
   * the window (01-PRODUCT-REQUIREMENTS §123). The row is a rate limiter, not evidence: it commits on
   * its own, prunes anything older than a day, and cascades away with its tournament.
   */
  async recordTestCreateAttempt(tournamentId: UUID, teamId: UUID, actor: Actor): Promise<void> {
    // The ownership check runs first: a member of another team must not be able to burn this window.
    this.checkActorTeam(teamId, actor);
    if (actor.role === 'ADMIN') throw new SubmissionError(403, 'Private tests belong to the owning team only');

    const tournament = await this.db.query<{ id: string }>('SELECT id FROM tournaments WHERE id = $1', [
      tournamentId,
    ]);
    if (tournament.rows.length === 0) {
      throw new SubmissionError(404, 'Tournament not found');
    }

    const attemptsInWindow = await this.db.withTransaction(async (client) => {
      await client.query(
        `DELETE FROM test_create_attempts
         WHERE tournament_id = $1 AND team_id = $2 AND created_at < clock_timestamp() - interval '1 day'`,
        [tournamentId, teamId]
      );
      await client.query(
        'INSERT INTO test_create_attempts (tournament_id, team_id, user_id) VALUES ($1, $2, $3)',
        [tournamentId, teamId, actor.userId]
      );
      const windowRes = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM test_create_attempts
         WHERE tournament_id = $1 AND team_id = $2 AND created_at >= clock_timestamp() - interval '1 minute'`,
        [tournamentId, teamId]
      );
      return parseInt(windowRes.rows[0].count, 10);
    });

    if (attemptsInWindow > QUOTA_POLICY.testCreatePerMinute) {
      throw new SubmissionError(
        429,
        `Private test create rate exceeded: max ${QUOTA_POLICY.testCreatePerMinute} requests per rolling minute`,
        'QUOTA_EXCEEDED',
        { quota: 'TEST_CREATE_RATE', limit: QUOTA_POLICY.testCreatePerMinute }
      );
    }
  }

  async submit(
    tournamentId: UUID,
    teamId: UUID,
    upload: { language: BotLanguage; entrypoint: string; zipBuffer: Buffer },
    actor: Actor
  ): Promise<SubmissionReceipt> {
    // An official receipt is the team's own act: an organizer reads submitted work, but never
    // submits, replaces or impersonates a team's candidate (01 §44/§52). The private-test twins
    // already refuse ADMIN for the same reason.
    if (actor.role === 'ADMIN') {
      throw new SubmissionError(403, 'An administrator cannot submit source for a team', 'ADMIN_CANNOT_SUBMIT');
    }
    this.checkActorTeam(teamId, actor);
    await this.backupFence?.assertFresh();

    const receipt = await this.db.withTransaction(async (client): Promise<SubmissionReceipt> => {
      // 1. Lock and check tournament state and deadline
      const tRes = await client.query<TournamentCheckRow>(
        'SELECT id, state, registration_closes_at FROM tournaments WHERE id = $1 FOR UPDATE',
        [tournamentId]
      );
      const tournament = tRes.rows[0];
      if (!tournament) {
        throw new SubmissionError(404, 'Tournament not found');
      }

      if (!['REGISTRATION_OPEN', 'VALIDATING_SUBMISSIONS'].includes(tournament.state)) {
        throw new SubmissionError(409, `Submissions closed: tournament state is ${tournament.state}`);
      }

      if (tournament.registration_closes_at && new Date() > tournament.registration_closes_at) {
        throw new SubmissionError(409, 'Submissions closed: registration deadline has passed');
      }

      // 2. Check team admission
      const admRes = await client.query(
        'SELECT id FROM tournament_admissions WHERE tournament_id = $1 AND team_id = $2',
        [tournamentId, teamId]
      );
      if (admRes.rows.length === 0) {
        throw new SubmissionError(403, 'Team is not enrolled in this tournament');
      }

      // 3. Quotas (official receipts, per tournament+team) — see assertOfficialQuota
      await this.assertOfficialQuota(client, tournamentId, teamId);

      // 4. Store source artifact with fsync durability
      const stored = await this.artifactStore.storeSource(upload.zipBuffer, upload.language, upload.entrypoint, client);

      // 5. Monotonic receipt ordinal assignment under lock
      const maxOrdinalRes = await client.query<{ max: number | null }>(
        'SELECT max(receipt_ordinal) as max FROM submissions WHERE tournament_id = $1 AND team_id = $2',
        [tournamentId, teamId]
      );
      const nextOrdinal = (maxOrdinalRes.rows[0].max ?? 0) + 1;

      // 6. Insert submission. Intake does not decide usability: the receipt starts VALIDATING
      // and only the build pipeline (compile + smoke test) may move it to READY.
      const subRes = await client.query<SubmissionRow>(
        `INSERT INTO submissions (tournament_id, team_id, submitted_by_user_id, receipt_ordinal, source_digest, language, entrypoint, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'VALIDATING')
         RETURNING *`,
        [tournamentId, teamId, actor.userId, nextOrdinal, stored.digest, upload.language, upload.entrypoint]
      );
      const submission = subRes.rows[0];

      // Audit event
      await client.query(
        `INSERT INTO audit_events (actor_user_id, action, resource_type, resource_id, details)
         VALUES ($1, 'SUBMIT_SOURCE', 'SUBMISSION', $2, $3)`,
        [actor.userId, submission.id, JSON.stringify({ tournamentId, teamId, ordinal: nextOrdinal, digest: stored.digest })]
      );

      return {
        receiptId: submission.id,
        timestamp: submission.received_at.toISOString(),
        data: {
          submissionId: submission.id,
          receivedAt: submission.received_at.toISOString(),
          receiptOrdinal: submission.receipt_ordinal,
          sourceDigest: stored.digest,
          intakeEligibility: 'ELIGIBLE',
          status: 'VALIDATING',
        },
      };
    });

    // Enqueued only once the receipt row is committed: a job must never point at a row a
    // rolled-back transaction could have erased. `enqueueIfAbsent` keeps this idempotent, so a
    // retried submit cannot buy a second build.
    await this.jobBroker.enqueueIfAbsent('BUILD', receipt.data.submissionId, BUILD_JOB_PRIORITY, {
      tournamentId,
      teamId,
    });

    return receipt;
  }

  async createPrivateTest(
    tournamentId: UUID,
    teamId: UUID,
    upload: { language: BotLanguage; entrypoint: string; zipBuffer: Buffer },
    actor: Actor
  ): Promise<TestReceipt> {
    this.checkActorTeam(teamId, actor);
    if (actor.role === 'ADMIN') throw new SubmissionError(403, 'Private tests belong to the owning team only');

    const receipt = await this.db.withTransaction(async (client): Promise<TestReceipt> => {
      // 1. Quotas (private TEST requests, per tournament+team) — see assertTestQuota
      await this.assertTestQuota(client, tournamentId, teamId);

      // 2. Store source artifact
      const stored = await this.artifactStore.storeSource(upload.zipBuffer, upload.language, upload.entrypoint, client);

      // 3. Insert test snapshot (allowed in ALL tournament states)
      const testRes = await client.query<{ id: string; created_at: Date }>(
        `INSERT INTO test_snapshots (tournament_id, team_id, created_by_user_id, source_digest, language, entrypoint, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'QUEUED')
         RETURNING id, created_at`,
        [tournamentId, teamId, actor.userId, stored.digest, upload.language, upload.entrypoint]
      );

      const test = testRes.rows[0];
      return {
        receiptId: test.id,
        timestamp: test.created_at.toISOString(),
        data: {
          testId: test.id,
          queuedAt: test.created_at.toISOString(),
          sourceDigest: stored.digest,
        },
      };
    });

    // Same commit-then-enqueue rule as official receipts: the snapshot stays QUEUED until the
    // build pipeline has compiled and smoke-tested it.
    await this.jobBroker.enqueueIfAbsent('TEST_BUILD', receipt.data.testId, BUILD_JOB_PRIORITY, {
      tournamentId,
      teamId,
    });

    return receipt;
  }

  async getLatestCandidate(tournamentId: UUID, teamId: UUID, actor: Actor): Promise<SubmissionDto | null> {
    this.checkActorTeam(teamId, actor);

    const res = await this.db.query<SubmissionRow>(
      `SELECT * FROM submissions
       WHERE tournament_id = $1 AND team_id = $2 AND status = 'READY'
       ORDER BY receipt_ordinal DESC
       LIMIT 1`,
      [tournamentId, teamId]
    );

    const row = res.rows[0];
    if (!row) return null;

    return {
      id: row.id,
      tournamentId: row.tournament_id,
      teamId: row.team_id,
      receiptOrdinal: row.receipt_ordinal,
      sourceDigest: row.source_digest,
      language: row.language,
      entrypoint: row.entrypoint,
      status: row.status,
      rejectReason: row.reject_reason ?? undefined,
      receivedAt: row.received_at.toISOString(),
    };
  }

  async listSubmissions(tournamentId: UUID, teamId: UUID, actor: Actor): Promise<readonly SubmissionHistoryItem[]> {
    this.checkActorTeam(teamId, actor);

    const tournamentRes = await this.db.query<{ id: string }>(
      'SELECT id FROM tournaments WHERE id = $1',
      [tournamentId]
    );
    if (tournamentRes.rows.length === 0) {
      throw new SubmissionError(404, 'Tournament not found');
    }

    const res = await this.db.query<SubmissionHistoryRow>(
      `SELECT id, receipt_ordinal, source_digest, language, entrypoint, status, created_at
       FROM submissions
       WHERE tournament_id = $1 AND team_id = $2
       ORDER BY receipt_ordinal DESC`,
      [tournamentId, teamId]
    );

    return res.rows.map((row) => ({
      id: row.id,
      receiptOrdinal: row.receipt_ordinal,
      language: row.language,
      entrypoint: row.entrypoint,
      sourceDigest: row.source_digest,
      status: row.status,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async getSubmissionBuildLog(submissionId: UUID, actor: Actor, requestId?: string): Promise<{ submissionId: string; status: string; buildError: string | null; builtAt: string | null }> {
    const result = await this.db.query<{ team_id: string; status: string; build_error: string | null; built_at: Date | null }>(
      'SELECT team_id, status, build_error, built_at FROM submissions WHERE id = $1', [submissionId]);
    const row = result.rows[0];
    if (!row) throw new SubmissionError(404, 'Submission not found');
    this.checkActorTeam(row.team_id, actor);
    await this.db.query(`INSERT INTO audit_events(actor_user_id, action, resource_type, resource_id, request_id, details)
      VALUES ($1, 'SUBMISSION_BUILD_LOG_READ', 'submission', $2, $3, $4)`,
      [actor.userId, submissionId, auditRequestId(requestId), JSON.stringify({ teamId: row.team_id, role: actor.role })]);
    return { submissionId, status: row.status, buildError: row.build_error, builtAt: row.built_at?.toISOString() ?? null };
  }

  async getSubmissionSource(submissionId: UUID, actor: Actor, requestId?: string): Promise<PrivateSourceDto> {
    const res = await this.db.query<SubmissionRow>(
      'SELECT * FROM submissions WHERE id = $1',
      [submissionId]
    );
    const sub = res.rows[0];
    if (!sub) {
      throw new SubmissionError(404, 'Submission not found');
    }

    // Access control: only team members or ADMIN can read source code
    this.checkActorTeam(sub.team_id, actor);
    if (actor.role === 'ADMIN') {
      await this.db.query(
        `INSERT INTO audit_events (actor_user_id, action, resource_type, resource_id, request_id, details)
         VALUES ($1, 'ADMIN_INSPECT_SOURCE', 'submission', $2, $3, $4)`,
        [actor.userId, submissionId, auditRequestId(requestId), JSON.stringify({ teamId: sub.team_id, language: sub.language })]
      );
    }
    // Every read of submitted source is audited, not just the admin inspection trail.
    await this.db.query(
      `INSERT INTO audit_events (actor_user_id, action, resource_type, resource_id, request_id, details)
       VALUES ($1, 'SUBMISSION_SOURCE_READ', 'submission', $2, $3, $4)`,
      [actor.userId, submissionId, auditRequestId(requestId), JSON.stringify({ teamId: sub.team_id, language: sub.language, role: actor.role })]
    );

    const source = await this.artifactStore.getSource(sub.source_digest);
    if (!source) {
      throw new SubmissionError(404, 'Source artifact not found on disk');
    }

    return {
      submissionId: sub.id,
      sourceDigest: sub.source_digest,
      language: sub.language,
      entrypoint: sub.entrypoint,
      manifest: source.manifest,
      zipBase64: source.zipBuffer.toString('base64'),
    };
  }
}
