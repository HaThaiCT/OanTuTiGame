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
  /** Extra pool maps this fixture adds, so the knockout pool policy is satisfied. */
  const poolFixtureMapIds: string[] = [];
  /** Tournaments this file creates purely to assert a refusal. */
  const sparseTournamentIds: string[] = [];
  /** Tournaments/maps created by the idempotent-start test. */
  const idempotencyTournamentIds: string[] = [];
  const idempotencyMapIds: string[] = [];

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
    if (idempotencyTournamentIds.length > 0) {
      await db.query('DELETE FROM command_receipts WHERE scope LIKE $1', [`%${runId}%`]);
      await db.query('DELETE FROM tournament_map_pool WHERE tournament_id = ANY($1::uuid[])', [idempotencyTournamentIds]);
      await db.query('DELETE FROM tournament_entries WHERE tournament_id = ANY($1::uuid[])', [idempotencyTournamentIds]);
      await db.query(`DELETE FROM outbox_events WHERE payload->>'tournamentId' = ANY($1::text[])`, [
        idempotencyTournamentIds,
      ]);
      await db.query('DELETE FROM tournaments WHERE id = ANY($1::uuid[])', [idempotencyTournamentIds]);
    }
    if (idempotencyMapIds.length > 0) {
      await db.query('DELETE FROM map_versions WHERE map_id = ANY($1::uuid[])', [idempotencyMapIds]);
      await db.query('DELETE FROM maps WHERE id = ANY($1::uuid[])', [idempotencyMapIds]);
    }
    if (sparseTournamentIds.length > 0) {
      await db.query('DELETE FROM tournament_map_pool WHERE tournament_id = ANY($1::uuid[])', [sparseTournamentIds]);
      await db.query('DELETE FROM tournaments WHERE id = ANY($1::uuid[])', [sparseTournamentIds]);
    }
    if (poolFixtureMapIds.length > 0) {
      await db.query('DELETE FROM tournament_map_pool WHERE map_id = ANY($1::uuid[])', [poolFixtureMapIds]);
      await db.query('DELETE FROM map_versions WHERE map_id = ANY($1::uuid[])', [poolFixtureMapIds]);
      await db.query('DELETE FROM maps WHERE id = ANY($1::uuid[])', [poolFixtureMapIds]);
    }
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

      // Seed the pool row directly: pool *management* is admin- and state-guarded and covered by
      // map-pool.test.ts; this fixture only needs the hidden map inside the pool to assert that
      // lock reveals it.
      await db.query(
        `INSERT INTO tournament_map_pool (tournament_id, map_id) VALUES ($1, $2)
         ON CONFLICT (tournament_id, map_id) DO NOTHING`,
        [testTournamentId, testHiddenMapId]
      );

      // A knockout preset needs at least four maps in the frozen pool, so the lock/start pair below
      // runs under the same rule a real tournament obeys: the public map plus three more.
      for (const mapId of [pubMap.id]) {
        await db.query(
          `INSERT INTO tournament_map_pool (tournament_id, map_id) VALUES ($1, $2)
           ON CONFLICT (tournament_id, map_id) DO NOTHING`,
          [testTournamentId, mapId]
        );
      }
      for (let index = 1; index <= 3; index += 1) {
        const filler = await mapService.createMap(adminActor, {
          slug: `pool_${index}_${runId}`,
          displayName: `Pool Map ${index}`,
          descriptor: { ...publicMapDesc, mapName: `pool_${index}_${runId}` },
          visibility: 'PUBLIC',
        });
        poolFixtureMapIds.push(filler.id);
        await db.query(
          `INSERT INTO tournament_map_pool (tournament_id, map_id) VALUES ($1, $2)
           ON CONFLICT (tournament_id, map_id) DO NOTHING`,
          [testTournamentId, filler.id]
        );
      }
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
    it('refuses to start a knockout tournament whose frozen pool cannot host the series', async () => {
      const sparse = await db.query<{ id: string }>(
        `INSERT INTO tournaments (course_id, name, format, state)
         VALUES ($1, $2, 'SINGLE_ELIMINATION', 'READY_TO_START') RETURNING id`,
        [testCourseId, `Sparse Pool Cup ${runId}`]
      );
      sparseTournamentIds.push(sparse.rows[0].id);
      await db.query(
        `INSERT INTO tournament_map_pool (tournament_id, map_id) VALUES ($1, $2)`,
        [sparse.rows[0].id, testHiddenMapId]
      );

      await expect(lifecycleService.start(sparse.rows[0].id, adminCtx)).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining('MAP_POOL_TOO_SMALL'),
      });
    });


    it('replays the receipt for the same idempotency key and refuses a stale expected version', async () => {
      /** A startable knockout tournament: 2 eligible entries and a policy-sized frozen pool. */
      async function insertReadyTournament(tag: string): Promise<string> {
        const tournament = await db.query<{ id: string }>(
          `INSERT INTO tournaments (course_id, name, format, state, version)
           VALUES ($1, $2, 'SINGLE_ELIMINATION', 'READY_TO_START', 1) RETURNING id`,
          [testCourseId, `${tag} Cup ${runId}`]
        );
        const tournamentId = tournament.rows[0].id;
        idempotencyTournamentIds.push(tournamentId);
        await db.query(
          `INSERT INTO tournament_entries (tournament_id, team_id, status, seed_ordinal)
           VALUES ($1, $2, 'ELIGIBLE', 1), ($1, $3, 'ELIGIBLE', 2)`,
          [tournamentId, testTeamAId, testTeamBId]
        );
        for (let index = 1; index <= 4; index += 1) {
          const descriptor: MapDescriptor = {
            mapName: `idem-${tag}-${index}-${runId}`,
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
          const map = await db.query<{ id: string }>(
            `INSERT INTO maps (slug, display_name, descriptor, visibility, validation_warnings, current_version)
             VALUES ($1, $2, $3, 'PUBLIC', '[]'::jsonb, 1) RETURNING id`,
            [descriptor.mapName, `Idem Map ${index}`, JSON.stringify(descriptor)]
          );
          idempotencyMapIds.push(map.rows[0].id);
          await db.query(
            `INSERT INTO map_versions (map_id, version, descriptor, validation_warnings)
             VALUES ($1, 1, $2, '[]'::jsonb)`,
            [map.rows[0].id, JSON.stringify(descriptor)]
          );
          await db.query(`INSERT INTO tournament_map_pool (tournament_id, map_id, map_version) VALUES ($1, $2, 1)`, [
            tournamentId,
            map.rows[0].id,
          ]);
        }
        return tournamentId;
      }

      const idempotentTournament = await insertReadyTournament('Idempotent');
      const key = `idem-${runId}-${Math.random().toString(36).slice(2, 12)}-idempotency`;
      const keyed: CommandContext = { ...adminCtx, idempotencyKey: key };

      const first = await lifecycleService.start(idempotentTournament, keyed);
      expect(first.data.state).toBe('RUNNING');

      // The retry returns the canonical receipt instead of starting (or failing) again.
      const replay = await lifecycleService.start(idempotentTournament, keyed);
      expect(replay.receiptId).toBe(first.receiptId);
      // The stored receipt comes back from JSONB as an ISO string while a fresh one carries the driver's
      // Date: the wire form is identical either way, which is what the caller compares.
      const iso = (value: unknown) => new Date(value as string | Date).toISOString();
      expect(iso(replay.data.startedAt)).toBe(iso(first.data.startedAt));

      const started = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM outbox_events
          WHERE topic = 'TOURNAMENT_STARTED' AND payload->>'tournamentId' = $1`,
        [idempotentTournament]
      );
      expect(started.rows[0].count).toBe('1');
      const versioned = await db.query<{ version: number }>('SELECT version FROM tournaments WHERE id = $1', [
        idempotentTournament,
      ]);
      expect(versioned.rows[0].version).toBe(2);

      // The same key with a different payload is a conflict, not a silent second start.
      await expect(
        lifecycleService.start(idempotentTournament, keyed, { mapSlug: 'some-other-map' })
      ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('IDEMPOTENCY_CONFLICT') });

      // A caller that acted on a stale version is refused before anything changes.
      const staleTournament = await insertReadyTournament('Stale');
      await expect(
        lifecycleService.start(staleTournament, { ...adminCtx, expectedVersion: 99 })
      ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('STALE_VERSION') });
      const untouched = await db.query<{ state: string; version: number }>(
        'SELECT state, version FROM tournaments WHERE id = $1',
        [staleTournament]
      );
      expect(untouched.rows[0]).toEqual({ state: 'READY_TO_START', version: 1 });
    });

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
