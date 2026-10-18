import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Actor, CommandContext } from '@oantuti/protocol';
import { PostgresDatabase } from '../src/persistence/db.js';
import { TournamentLifecycleService, TournamentError } from '../src/tournaments/lifecycle-service.js';
import { SubmissionService } from '../src/submissions/service.js';
import { ArtifactStore } from '../src/submissions/artifact-store.js';

describe('S15: Organizer Portal, Map Editor & Admin Control (T10)', () => {
  let db: PostgresDatabase;
  let lifecycleService: TournamentLifecycleService;
  let submissionService: SubmissionService;
  let artifactStore: ArtifactStore;

  const runId = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;

  let adminActor: Actor;
  let studentActor: Actor;
  let adminCtx: CommandContext;
  let studentCtx: CommandContext;

  let testCourseId: string;
  let testTournamentId: string;
  let testTeamId: string;

  beforeAll(async () => {
    db = new PostgresDatabase();
    lifecycleService = new TournamentLifecycleService(db);
    artifactStore = new ArtifactStore(db, `/tmp/oantuti-test-org-${runId}`);
    submissionService = new SubmissionService(db, artifactStore);

    // Bootstrap Users
    const uAdmin = await db.query<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
       VALUES ($1, 'Admin', 'hash', 'ADMIN', 'LOCAL_BOOTSTRAP', FALSE) RETURNING id`,
      [`org_admin_${runId}`]
    );

    const uStudent = await db.query<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
       VALUES ($1, 'Student', 'hash', 'STUDENT', 'ADMIN_ISSUED', FALSE) RETURNING id`,
      [`org_student_${runId}`]
    );

    // Course
    const courseRes = await db.query<{ id: string }>(
      `INSERT INTO courses (code, name) VALUES ($1, 'Organizer Operations Course') RETURNING id`,
      [`ORG_COURSE_${runId}`]
    );
    testCourseId = courseRes.rows[0].id;

    // Team
    const tRes = await db.query<{ id: string }>(
      `INSERT INTO teams (course_id, name, captain_user_id) VALUES ($1, $2, $3) RETURNING id`,
      [testCourseId, `Team Alpha ${runId}`, uStudent.rows[0].id]
    );
    testTeamId = tRes.rows[0].id;

    adminActor = {
      userId: uAdmin.rows[0].id,
      role: 'ADMIN',
      username: `org_admin_${runId}`,
      teamIds: [],
      scope: 'FULL',
    };

    studentActor = {
      userId: uStudent.rows[0].id,
      role: 'STUDENT',
      username: `org_student_${runId}`,
      teamIds: [testTeamId],
      scope: 'FULL',
    };

    adminCtx = { actor: adminActor, requestId: randomUUID() };
    studentCtx = { actor: studentActor, requestId: randomUUID() };

    // Active Tournament (REGISTRATION_OPEN with future cutoff)
    const tourneyRes = await db.query<{ id: string }>(
      `INSERT INTO tournaments (course_id, name, format, state, registration_closes_at)
       VALUES ($1, 'Org Ops Tournament', 'SINGLE_ELIMINATION', 'REGISTRATION_OPEN', clock_timestamp() + INTERVAL '1 hour')
       RETURNING id`,
      [testCourseId]
    );
    testTournamentId = tourneyRes.rows[0].id;
  });

  afterAll(async () => {
    await db.close();
  });

  describe('1. Registration Deadline Extension Invariants', () => {
    it('denies student from extending tournament registration', async () => {
      const newClosesAt = new Date(Date.now() + 2 * 3600 * 1000);
      await expect(
        lifecycleService.extendRegistration(testTournamentId, newClosesAt, studentCtx)
      ).rejects.toThrow(TournamentError);
    });

    it('allows Admin to extend registration before current cutoff has passed', async () => {
      const newClosesAt = new Date(Date.now() + 3 * 3600 * 1000);
      const res = await lifecycleService.extendRegistration(testTournamentId, newClosesAt, adminCtx);

      expect(res.tournamentId).toBe(testTournamentId);
      expect(res.registrationClosesAt).toBe(newClosesAt.toISOString());

      // Verify audit event
      const audit = await db.query<{ action: string; details: any }>(
        `SELECT action, details FROM audit_events WHERE action = 'REGISTRATION_EXTENDED' ORDER BY created_at DESC LIMIT 1`
      );
      expect(audit.rows.length).toBe(1);
    });

    it('strictly denies extending registration once cutoff has passed', async () => {
      // Fast-forward cutoff to past
      await db.query(
        "UPDATE tournaments SET registration_closes_at = clock_timestamp() - INTERVAL '5 minutes' WHERE id = $1",
        [testTournamentId]
      );

      const futureDate = new Date(Date.now() + 5 * 3600 * 1000);
      await expect(
        lifecycleService.extendRegistration(testTournamentId, futureDate, adminCtx)
      ).rejects.toThrow(/EXTENSION_DENIED/);
    });
  });

  describe('2. Tournament Pause and Resume Controls', () => {
    it('allows Admin to pause running tournament and then resume it', async () => {
      // Set tournament to RUNNING
      await db.query("UPDATE tournaments SET state = 'RUNNING' WHERE id = $1", [testTournamentId]);

      // Pause
      const paused = await lifecycleService.pauseTournament(testTournamentId, adminCtx);
      expect(paused.state).toBe('PAUSED');

      const tourneyPaused = await db.query<{ state: string }>(
        'SELECT state FROM tournaments WHERE id = $1',
        [testTournamentId]
      );
      expect(tourneyPaused.rows[0].state).toBe('PAUSED');

      // Verify outbox event
      const outboxPause = await db.query<{ payload: any }>(
        `SELECT payload FROM outbox_events WHERE topic = 'TOURNAMENT_PAUSED' ORDER BY created_at DESC LIMIT 1`
      );
      expect(outboxPause.rows[0].payload.tournamentId).toBe(testTournamentId);

      // Resume
      const resumed = await lifecycleService.resumeTournament(testTournamentId, adminCtx);
      expect(resumed.state).toBe('RUNNING');

      const tourneyResumed = await db.query<{ state: string }>(
        'SELECT state FROM tournaments WHERE id = $1',
        [testTournamentId]
      );
      expect(tourneyResumed.rows[0].state).toBe('RUNNING');
    });

    it('denies non-admin from executing pause or resume', async () => {
      await expect(
        lifecycleService.pauseTournament(testTournamentId, studentCtx)
      ).rejects.toThrow(TournamentError);

      await expect(
        lifecycleService.resumeTournament(testTournamentId, studentCtx)
      ).rejects.toThrow(TournamentError);
    });
  });
});
