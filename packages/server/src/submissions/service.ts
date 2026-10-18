import { randomUUID } from 'node:crypto';
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
  TestReceipt,
  TestSnapshotDto,
  UUID,
} from '@oantuti/protocol';

export class SubmissionError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = 'SubmissionError';
  }
}

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

interface TournamentCheckRow {
  readonly id: string;
  readonly state: string;
  readonly registration_closes_at: Date | null;
}

export class SubmissionService {
  constructor(
    private readonly db: Database,
    private readonly artifactStore: ArtifactStore
  ) {}

  private checkActorTeam(teamId: UUID, actor: Actor): void {
    if (actor.role === 'ADMIN') return;
    if (actor.scope !== 'FULL') {
      throw new SubmissionError(403, 'Session requires full scope to submit code');
    }
    if (!actor.teamIds.includes(teamId)) {
      throw new SubmissionError(403, 'Forbidden: You do not belong to this team');
    }
  }

  async submit(
    tournamentId: UUID,
    teamId: UUID,
    upload: { language: BotLanguage; entrypoint: string; zipBuffer: Buffer },
    actor: Actor
  ): Promise<SubmissionReceipt> {
    this.checkActorTeam(teamId, actor);

    return this.db.withTransaction(async (client) => {
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

      // 3. Quota checks: max 10 submissions in rolling 60 min, max 100/day
      const quotaHourRes = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM submissions
         WHERE team_id = $1 AND received_at > clock_timestamp() - INTERVAL '60 minutes'`,
        [teamId]
      );
      if (parseInt(quotaHourRes.rows[0].count, 10) >= 10) {
        throw new SubmissionError(429, 'Hourly submission quota exceeded (max 10 per rolling 60 minutes)');
      }

      const quotaDayRes = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM submissions
         WHERE team_id = $1 AND received_at > date_trunc('day', clock_timestamp())`,
        [teamId]
      );
      if (parseInt(quotaDayRes.rows[0].count, 10) >= 100) {
        throw new SubmissionError(429, 'Daily submission quota exceeded (max 100 per day UTC)');
      }

      // 4. Store source artifact with fsync durability
      const stored = await this.artifactStore.storeSource(upload.zipBuffer, upload.language, upload.entrypoint);

      // 5. Monotonic receipt ordinal assignment under lock
      const maxOrdinalRes = await client.query<{ max: number | null }>(
        'SELECT max(receipt_ordinal) as max FROM submissions WHERE tournament_id = $1 AND team_id = $2',
        [tournamentId, teamId]
      );
      const nextOrdinal = (maxOrdinalRes.rows[0].max ?? 0) + 1;

      // 6. Insert submission
      const subRes = await client.query<SubmissionRow>(
        `INSERT INTO submissions (tournament_id, team_id, submitted_by_user_id, receipt_ordinal, source_digest, language, entrypoint, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'READY')
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
        },
      };
    });
  }

  async createPrivateTest(
    tournamentId: UUID,
    teamId: UUID,
    upload: { language: BotLanguage; entrypoint: string; zipBuffer: Buffer },
    actor: Actor
  ): Promise<TestReceipt> {
    this.checkActorTeam(teamId, actor);

    return this.db.withTransaction(async (client) => {
      // 1. Quota check: max 2 pending, max 30 per day
      const pendingRes = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM test_snapshots
         WHERE team_id = $1 AND status IN ('QUEUED', 'RUNNING')`,
        [teamId]
      );
      if (parseInt(pendingRes.rows[0].count, 10) >= 2) {
        throw new SubmissionError(429, 'Private test quota exceeded: max 2 pending runs');
      }

      const dailyRes = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM test_snapshots
         WHERE team_id = $1 AND created_at > date_trunc('day', clock_timestamp())`,
        [teamId]
      );
      if (parseInt(dailyRes.rows[0].count, 10) >= 30) {
        throw new SubmissionError(429, 'Daily private test quota exceeded (max 30 per day UTC)');
      }

      // 2. Store source artifact
      const stored = await this.artifactStore.storeSource(upload.zipBuffer, upload.language, upload.entrypoint);

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

  async getSubmissionSource(submissionId: UUID, actor: Actor): Promise<PrivateSourceDto> {
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
        `INSERT INTO audit_events (actor_user_id, action, resource_type, resource_id, details)
         VALUES ($1, 'ADMIN_INSPECT_SOURCE', 'submission', $2, $3)`,
        [actor.userId, submissionId, JSON.stringify({ teamId: sub.team_id, language: sub.language })]
      );
    }

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
