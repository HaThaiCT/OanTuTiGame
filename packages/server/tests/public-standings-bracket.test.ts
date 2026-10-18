import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { MapDescriptor } from '@oantuti/engine';
import { createApp } from '../src/app.js';
import { PostgresDatabase } from '../src/persistence/db.js';

const sampleMap: MapDescriptor = {
  mapName: 'public-test-map-3x3',
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

describe('S13: Tournament Public SSR, Standings, Brackets & Replay (T8)', () => {
  let app: FastifyInstance;
  let db: PostgresDatabase;

  const runId = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;

  let testCourseId: string;
  let testTournamentId: string;
  let testTeamAId: string;
  let testTeamBId: string;
  let testEncounterId: string;

  beforeAll(async () => {
    db = new PostgresDatabase();
    const appCtx = await createApp({ pgDb: db });
    app = appCtx.app;

    // Course
    const courseRes = await db.query<{ id: string }>(
      `INSERT INTO courses (code, name) VALUES ($1, 'Public Portal Course') RETURNING id`,
      [`PUB_COURSE_${runId}`]
    );
    testCourseId = courseRes.rows[0].id;

    // Users & Teams
    const u1 = await db.query<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
       VALUES ($1, 'Captain 1', 'hash', 'STUDENT', 'ADMIN_ISSUED', FALSE) RETURNING id`,
      [`pub_user_1_${runId}`]
    );
    const u2 = await db.query<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
       VALUES ($1, 'Captain 2', 'hash', 'STUDENT', 'ADMIN_ISSUED', FALSE) RETURNING id`,
      [`pub_user_2_${runId}`]
    );

    const tA = await db.query<{ id: string }>(
      `INSERT INTO teams (course_id, name, captain_user_id) VALUES ($1, $2, $3) RETURNING id`,
      [testCourseId, `Phoenix Squad ${runId}`, u1.rows[0].id]
    );
    testTeamAId = tA.rows[0].id;

    const tB = await db.query<{ id: string }>(
      `INSERT INTO teams (course_id, name, captain_user_id) VALUES ($1, $2, $3) RETURNING id`,
      [testCourseId, `Vanguard Esports ${runId}`, u2.rows[0].id]
    );
    testTeamBId = tB.rows[0].id;

    // Active Tournament
    const tourneyRes = await db.query<{ id: string }>(
      `INSERT INTO tournaments (course_id, name, format, state)
       VALUES ($1, 'OanTuTi Open Championship 2026', 'SWISS_PLAYOFF', 'RUNNING')
       RETURNING id`,
      [testCourseId]
    );
    testTournamentId = tourneyRes.rows[0].id;

    // Standings Snapshot for Round 1
    await db.query(
      `INSERT INTO standings_snapshots (
         tournament_id, stage, round_ordinal, team_id, rank, points,
         matches_played, wins, draws, losses, buchholz, sonneborn_berger, rating_elo, is_qualified
       ) VALUES ($1, 'MAIN', 1, $2, 1, 3.0, 1, 1, 0, 0, 0.0, 0.0, 1216.0, TRUE),
                ($1, 'MAIN', 1, $3, 2, 0.0, 1, 0, 0, 1, 3.0, 0.0, 1184.0, FALSE)`,
      [testTournamentId, testTeamAId, testTeamBId]
    );

    // Encounter for Round 1
    const encRes = await db.query<{ id: string }>(
      `INSERT INTO encounters (
         tournament_id, stage, round_ordinal, slot_ordinal,
         team_a_id, team_b_id, status, winner_team_id, points_a, points_b
       ) VALUES ($1, 'MAIN', 1, 1, $2, $3, 'COMPLETED', $2, 3.0, 0.0)
       RETURNING id`,
      [testTournamentId, testTeamAId, testTeamBId]
    );
    testEncounterId = encRes.rows[0].id;
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  describe('1. Public Tournament Directory & Overview', () => {
    it('returns published and active tournaments on GET /api/v2/tournaments', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v2/tournaments',
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(Array.isArray(data.tournaments)).toBe(true);
      expect(data.tournaments.some((t: any) => t.id === testTournamentId)).toBe(true);
    });

    it('returns tournament overview with rules revision on GET /api/v2/tournaments/:id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v2/tournaments/${testTournamentId}`,
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.name).toBe('OanTuTi Open Championship 2026');
      expect(data.format).toBe('SWISS_PLAYOFF');
      expect(data.state).toBe('RUNNING');
    });
  });

  describe('2. Public Standings & Tiebreakers', () => {
    it('retrieves official standings snapshot for Swiss tournament', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v2/tournaments/${testTournamentId}/standings?stage=MAIN&round=1`,
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.tournamentId).toBe(testTournamentId);
      expect(data.roundOrdinal).toBe(1);
      expect(data.standings.length).toBe(2);

      // Rank 1
      const rank1 = data.standings[0];
      expect(rank1.rank).toBe(1);
      expect(rank1.points).toBe('3.0');
      expect(rank1.team_id).toBe(testTeamAId);
      expect(rank1.is_qualified).toBe(true);

      // Rank 2
      const rank2 = data.standings[1];
      expect(rank2.rank).toBe(2);
      expect(rank2.points).toBe('0.0');
      expect(rank2.team_id).toBe(testTeamBId);
      expect(rank2.is_qualified).toBe(false);
    });
  });

  describe('3. Public Bracket & Match History', () => {
    it('retrieves tournament encounters with team names and scores', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v2/tournaments/${testTournamentId}/bracket`,
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.encounters.length).toBe(1);

      const enc = data.encounters[0];
      expect(enc.encounter_id).toBe(testEncounterId);
      expect(enc.stage).toBe('MAIN');
      expect(enc.round_ordinal).toBe(1);
      expect(enc.status).toBe('COMPLETED');
      expect(enc.winner_team_id).toBe(testTeamAId);
      expect(enc.team_a_id).toBe(testTeamAId);
      expect(enc.team_b_id).toBe(testTeamBId);
      expect(enc.team_a_name).toMatch(/Phoenix Squad/);
      expect(enc.team_b_name).toMatch(/Vanguard Esports/);
    });
  });
});
