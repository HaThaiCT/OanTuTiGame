import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { MapDescriptor } from '@oantuti/engine';
import type { Actor, CommandContext } from '@oantuti/protocol';
import { PostgresDatabase } from '../src/persistence/db.js';
import { MapValidator } from '../src/tournaments/map-validator.js';
import { MapService, MapError } from '../src/tournaments/map-service.js';
import { TournamentLifecycleService, TournamentError } from '../src/tournaments/lifecycle-service.js';

describe('S08: Tournament Scheduler, Lock, Stage & Rounds (T6)', () => {
  let db: PostgresDatabase;
  let validator: MapValidator;
  let mapService: MapService;
  let lifecycleService: TournamentLifecycleService;

  const runId = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;

  const adminActor: Actor = {
    userId: randomUUID(),
    role: 'ADMIN',
    username: `admin_${runId}`,
    teamIds: [],
    scope: 'FULL',
  };

  const studentActor: Actor = {
    userId: randomUUID(),
    role: 'STUDENT',
    username: `student_${runId}`,
    teamIds: [],
    scope: 'FULL',
  };

  const adminCtx: CommandContext = {
    actor: adminActor,
    requestId: randomUUID(),
  };

  const studentCtx: CommandContext = {
    actor: studentActor,
    requestId: randomUUID(),
  };

  let testCourseId: string;
  let testTournamentId: string;
  let testTeamAId: string;
  let testTeamBId: string;
  let testHiddenMapId: string;
  let testHiddenMapSlug: string;

  beforeAll(async () => {
    db = new PostgresDatabase();
    validator = new MapValidator();
    mapService = new MapService(db, validator);
    lifecycleService = new TournamentLifecycleService(db);

    // Bootstrap admin & student users in DB
    await db.query(
      `INSERT INTO users (id, username, display_name, password_hash, role, activation_method, password_change_required)
       VALUES ($1, $2, 'Administrator', 'hash_admin', 'ADMIN', 'LOCAL_BOOTSTRAP', FALSE),
              ($3, $4, 'Student User', 'hash_student', 'STUDENT', 'ADMIN_ISSUED', FALSE)`,
      [adminActor.userId, adminActor.username, studentActor.userId, studentActor.username]
    );

    // Course
    const courseRes = await db.query<{ id: string }>(
      `INSERT INTO courses (code, name) VALUES ($1, 'Tournament Lifecycle Course') RETURNING id`,
      [`S08_COURSE_${runId}`]
    );
    testCourseId = courseRes.rows[0].id;

    // Teams
    const teamARes = await db.query<{ id: string }>(
      `INSERT INTO teams (course_id, name, captain_user_id) VALUES ($1, $2, $3) RETURNING id`,
      [testCourseId, `Team A ${runId}`, studentActor.userId]
    );
    testTeamAId = teamARes.rows[0].id;

    const teamBRes = await db.query<{ id: string }>(
      `INSERT INTO teams (course_id, name, captain_user_id) VALUES ($1, $2, $3) RETURNING id`,
      [testCourseId, `Team B ${runId}`, studentActor.userId]
    );
    testTeamBId = teamBRes.rows[0].id;

    // Tournament in REGISTRATION_OPEN
    const tourneyRes = await db.query<{ id: string }>(
      `INSERT INTO tournaments (course_id, name, format, state)
       VALUES ($1, 'Spring Championship 2026', 'SINGLE_ELIMINATION', 'REGISTRATION_OPEN')
       RETURNING id`,
      [testCourseId]
    );
    testTournamentId = tourneyRes.rows[0].id;

    // Direct enroll both teams in tournament_admissions
    await db.query(
      `INSERT INTO tournament_admissions (tournament_id, team_id, admitted_by_user_id, admission_type)
       VALUES ($1, $2, $3, 'DIRECT_ENROLLMENT'),
              ($1, $4, $3, 'DIRECT_ENROLLMENT')`,
      [testTournamentId, testTeamAId, adminActor.userId, testTeamBId]
    );
  });

  afterAll(async () => {
    await db.close();
  });

  describe('1. MapValidator Invariants & Warnings', () => {
    it('validates a standard map with zero warnings', () => {
      const map: MapDescriptor = {
        mapName: 'balanced_3x3',
        width: 3,
        height: 3,
        validTiles: [
          [0, 0], [1, 0], [2, 0],
          [0, 1], [1, 1], [2, 1],
          [0, 2], [1, 2], [2, 2],
        ],
        whiteThrone: [0, 0],
        blackThrone: [2, 2],
        startingPieces: [
          { id: 1, owner: 'WHITE', type: 'ROCK', pos: [0, 1] },
          { id: 2, owner: 'BLACK', type: 'ROCK', pos: [2, 1] },
        ],
      };

      const result = validator.validate(map);
      expect(result.isValid).toBe(true);
      expect(result.errors.length).toBe(0);
      expect(result.warnings.length).toBe(0);
    });

    it('emits non-fatal warnings for piece imbalance and occupied throne', () => {
      const map: MapDescriptor = {
        mapName: 'asymmetric_map',
        width: 3,
        height: 3,
        validTiles: [
          [0, 0], [1, 0], [2, 0],
          [0, 1], [1, 1], [2, 1],
          [0, 2], [1, 2], [2, 2],
        ],
        whiteThrone: [0, 0],
        blackThrone: [2, 2],
        startingPieces: [
          { id: 1, owner: 'WHITE', type: 'ROCK', pos: [0, 0] }, // Occupied throne!
          { id: 2, owner: 'WHITE', type: 'PAPER', pos: [0, 1] },
          { id: 3, owner: 'BLACK', type: 'SCISSORS', pos: [2, 1] }, // Imbalance: 2 white vs 1 black
        ],
      };

      const result = validator.validate(map);
      expect(result.isValid).toBe(true); // NOT rejected per specification
      expect(result.warnings.some((w) => w.code === 'OCCUPIED_THRONE')).toBe(true);
      expect(result.warnings.some((w) => w.code === 'UNBALANCED_PIECES')).toBe(true);
    });

    it('rejects maps with invalid boundaries or missing throne tiles', () => {
      const invalidMap: MapDescriptor = {
        mapName: 'bad_map',
        width: 2, // too small
        height: 2,
        validTiles: [[0, 0]],
        whiteThrone: [0, 0],
        blackThrone: [5, 5], // off map
        startingPieces: [],
      };

      const result = validator.validate(invalidMap);
      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('2. MapService & Visibility Access Control', () => {
    it('allows Admin to create PUBLIC and HIDDEN maps with warning retention', async () => {
      const publicMapDesc: MapDescriptor = {
        mapName: `public_${runId}`,
        width: 4,
        height: 4,
        validTiles: [
          [0, 0], [1, 0], [2, 0], [3, 0],
          [0, 1], [1, 1], [2, 1], [3, 1],
          [0, 2], [1, 2], [2, 2], [3, 2],
          [0, 3], [1, 3], [2, 3], [3, 3],
        ],
        whiteThrone: [0, 0],
        blackThrone: [3, 3],
        startingPieces: [
          { id: 1, owner: 'WHITE', type: 'ROCK', pos: [0, 1] },
          { id: 2, owner: 'BLACK', type: 'ROCK', pos: [3, 2] },
        ],
      };

      const pubMap = await mapService.createMap(adminActor, {
        slug: `pub_${runId}`,
        displayName: 'Public Arena',
        descriptor: publicMapDesc,
        visibility: 'PUBLIC',
      });
      expect(pubMap.visibility).toBe('PUBLIC');

      testHiddenMapSlug = `hidden_${runId}`;
      const hiddenMapDesc: MapDescriptor = {
        ...publicMapDesc,
        mapName: testHiddenMapSlug,
      };

      const hidMap = await mapService.createMap(adminActor, {
        slug: testHiddenMapSlug,
        displayName: 'Secret Championship Map',
        descriptor: hiddenMapDesc,
        visibility: 'HIDDEN',
      });
      expect(hidMap.visibility).toBe('HIDDEN');
      testHiddenMapId = hidMap.id;

      // Add to tournament map pool
      await mapService.addMapToPool(testTournamentId, testHiddenMapId);
    });

    it('denies Student access to HIDDEN map before tournament lock', async () => {
      // Student can read public map
      const pub = await mapService.getMap(`pub_${runId}`, studentActor);
      expect(pub.slug).toBe(`pub_${runId}`);

      // Student is denied reading hidden map
      await expect(
        mapService.getMap(testHiddenMapSlug, studentActor)
      ).rejects.toThrow(MapError);

      // Student listMaps does NOT include hidden map
      const list = await mapService.listMaps(studentActor);
      expect(list.some((m) => m.slug === testHiddenMapSlug)).toBe(false);

      // Admin CAN read hidden map
      const adminRead = await mapService.getMap(testHiddenMapSlug, adminActor);
      expect(adminRead.slug).toBe(testHiddenMapSlug);
    });
  });

  describe('3. Tournament Lock & Frozen Submission Invariants', () => {
    it('denies non-admin actor from executing lock command', async () => {
      await expect(
        lifecycleService.lock(testTournamentId, studentCtx)
      ).rejects.toThrow(TournamentError);
    });

    it('locks intake, selects latest valid submission by receipt ordinal, reveals hidden maps', async () => {
      // Create submissions for Team A:
      await db.query(
        `INSERT INTO submission_sources (digest, storage_path, zip_bytes, expanded_bytes, file_count, manifest)
         VALUES ('source_digest_s08', '/tmp/fake_s08.zip', 100, 200, 1, '[]'::jsonb)
         ON CONFLICT (digest) DO NOTHING`
      );

      // Sub 1: receipt ordinal 1, status READY
      // Sub 2: receipt ordinal 2, status READY (should be selected as frozen!)
      const sub1 = await db.query<{ id: string }>(
        `INSERT INTO submissions (tournament_id, team_id, submitted_by_user_id, source_digest, language, entrypoint, status, receipt_ordinal)
         VALUES ($1, $2, $3, 'source_digest_s08', 'PYTHON', 'main.py', 'READY', 1) RETURNING id`,
        [testTournamentId, testTeamAId, studentActor.userId]
      );

      const sub2 = await db.query<{ id: string }>(
        `INSERT INTO submissions (tournament_id, team_id, submitted_by_user_id, source_digest, language, entrypoint, status, receipt_ordinal)
         VALUES ($1, $2, $3, 'source_digest_s08', 'PYTHON', 'main.py', 'READY', 2) RETURNING id`,
        [testTournamentId, testTeamAId, studentActor.userId]
      );
      const teamAFrozenExpected = sub2.rows[0].id;

      // Create submission for Team B: receipt ordinal 3, status READY
      const subB = await db.query<{ id: string }>(
        `INSERT INTO submissions (tournament_id, team_id, submitted_by_user_id, source_digest, language, entrypoint, status, receipt_ordinal)
         VALUES ($1, $2, $3, 'source_digest_s08', 'PYTHON', 'main.py', 'READY', 3) RETURNING id`,
        [testTournamentId, testTeamBId, studentActor.userId]
      );
      const teamBFrozenExpected = subB.rows[0].id;
      // Admin executes LOCK
      const receipt = await lifecycleService.lock(testTournamentId, adminCtx);
      expect(receipt.data.tournamentId).toBe(testTournamentId);
      expect(receipt.data.state).toBe('READY_TO_START');
      expect(receipt.data.eligibleTeamsCount).toBe(2);
      expect(receipt.data.excludedTeamsCount).toBe(0);

      // Verify tournament state in DB
      const tourney = await db.query<{ state: string; locked_at: string }>(
        'SELECT state, locked_at FROM tournaments WHERE id = $1',
        [testTournamentId]
      );
      expect(tourney.rows[0].state).toBe('READY_TO_START');
      expect(tourney.rows[0].locked_at).not.toBeNull();

      // Verify frozen submission pointers in tournament_entries
      const entries = await db.query<{ team_id: string; status: string; frozen_submission_id: string; seed_ordinal: number }>(
        'SELECT team_id, status, frozen_submission_id, seed_ordinal FROM tournament_entries WHERE tournament_id = $1 ORDER BY seed_ordinal ASC',
        [testTournamentId]
      );
      expect(entries.rows.length).toBe(2);

      const entryA = entries.rows.find((e) => e.team_id === testTeamAId);
      expect(entryA?.status).toBe('ELIGIBLE');
      expect(entryA?.frozen_submission_id).toBe(teamAFrozenExpected);

      const entryB = entries.rows.find((e) => e.team_id === testTeamBId);
      expect(entryB?.status).toBe('ELIGIBLE');
      expect(entryB?.frozen_submission_id).toBe(teamBFrozenExpected);

      // Verify hidden map in the pool was revealed!
      const revealedMap = await mapService.getMap(testHiddenMapSlug, studentActor);
      expect(revealedMap.revealed_at).not.toBeNull();
      expect(revealedMap.slug).toBe(testHiddenMapSlug);

      // Verify outbox event TOURNAMENT_LOCKED
      const outbox = await db.query<{ payload: any }>(
        `SELECT payload FROM outbox_events WHERE topic = 'TOURNAMENT_LOCKED' ORDER BY created_at DESC LIMIT 1`
      );
      expect(outbox.rows[0].payload.tournamentId).toBe(testTournamentId);
      expect(outbox.rows[0].payload.eligibleTeamsCount).toBe(2);
    });
  });

  describe('4. Tournament Start Command Invariants', () => {
    it('denies non-admin from executing start command', async () => {
      await expect(
        lifecycleService.start(testTournamentId, studentCtx)
      ).rejects.toThrow(TournamentError);
    });

    it('starts locked tournament and advances state to RUNNING', async () => {
      const receipt = await lifecycleService.start(testTournamentId, adminCtx);
      expect(receipt.data.state).toBe('RUNNING');
      expect(receipt.data.tournamentId).toBe(testTournamentId);

      // Verify DB state
      const tourney = await db.query<{ state: string; started_at: string }>(
        'SELECT state, started_at FROM tournaments WHERE id = $1',
        [testTournamentId]
      );
      expect(tourney.rows[0].state).toBe('RUNNING');
      expect(tourney.rows[0].started_at).not.toBeNull();

      // Verify outbox event TOURNAMENT_STARTED
      const outbox = await db.query<{ payload: any }>(
        `SELECT payload FROM outbox_events WHERE topic = 'TOURNAMENT_STARTED' ORDER BY created_at DESC LIMIT 1`
      );
      expect(outbox.rows[0].payload.tournamentId).toBe(testTournamentId);
    });

    it('rejects duplicate start on an already RUNNING tournament with 409 Conflict', async () => {
      await expect(
        lifecycleService.start(testTournamentId, adminCtx)
      ).rejects.toThrow(TournamentError);
    });
  });
});
