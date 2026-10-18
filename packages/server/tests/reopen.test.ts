import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PostgresDatabase } from '../src/persistence/db.js';
import { TournamentAdmissionService } from '../src/tournaments/admission-service.js';
import { CorrectionService } from '../src/adjudication/correction-service.js';
import type { Actor, CommandContext } from '@oantuti/protocol';

/**
 * Finalized results are immutable until an explicit reopen: the correction preview must refuse,
 * and reopening must move the tournament back to PROVISIONAL with an audited outbox event.
 */
describe('S11: finalized results require an explicit reopen before corrections', () => {
  let db: PostgresDatabase;
  let admission: TournamentAdmissionService;
  let corrections: CorrectionService;
  const ids = {
    courseId: randomUUID(),
    userId: randomUUID(),
    teamA: randomUUID(),
    teamB: randomUUID(),
    tournamentId: randomUUID(),
    encounterId: randomUUID(),
    gameId: randomUUID(),
    versionId: randomUUID(),
  };
  const actor: Actor = {
    userId: ids.userId,
    username: 'reopen-admin',
    displayName: 'Reopen Admin',
    role: 'ADMIN',
    scope: 'FULL',
    teamIds: [],
  };
  const ctx: CommandContext = { actor, requestId: randomUUID() };

  beforeAll(async () => {
    db = new PostgresDatabase();
    admission = new TournamentAdmissionService(db);
    corrections = new CorrectionService(db);

    await db.query(
      `INSERT INTO users (id, username, display_name, password_hash, role, activation_method)
       VALUES ($1, $2, 'Reopen Admin', 'hash', 'ADMIN', 'LOCAL_BOOTSTRAP')`,
      [ids.userId, `reopen_${ids.userId.slice(0, 8)}`]
    );
    await db.query(`INSERT INTO courses (id, code, name) VALUES ($1, $2, 'Reopen Course')`, [
      ids.courseId,
      `REOPEN_${ids.courseId.slice(0, 8)}`,
    ]);
    for (const [teamId, name] of [
      [ids.teamA, 'Reopen A'],
      [ids.teamB, 'Reopen B'],
    ] as const) {
      await db.query(`INSERT INTO teams (id, course_id, name, captain_user_id) VALUES ($1, $2, $3, $4)`, [
        teamId,
        ids.courseId,
        name,
        ids.userId,
      ]);
    }
    await db.query(
      `INSERT INTO tournaments (id, course_id, name, format, state, finalized_at)
       VALUES ($1, $2, 'Reopen Cup', 'ROUND_ROBIN', 'FINALIZED', clock_timestamp())`,
      [ids.tournamentId, ids.courseId]
    );
    await db.query(
      `INSERT INTO encounters (id, tournament_id, round_ordinal, slot_ordinal, team_a_id, team_b_id, status, winner_team_id, points_a, points_b, stage)
       VALUES ($1, $2, 1, 1, $3, $4, 'COMPLETED', $3, 3, 0, 'MAIN')`,
      [ids.encounterId, ids.tournamentId, ids.teamA, ids.teamB]
    );
    await db.query(
      `INSERT INTO games (id, encounter_id, game_ordinal, white_team_id, black_team_id, map_descriptor, status)
       VALUES ($1, $2, 1, $3, $4, '{}'::jsonb, 'COMPLETED')`,
      [ids.gameId, ids.encounterId, ids.teamA, ids.teamB]
    );
    await db.query(
      `INSERT INTO replay_objects (digest, storage_path, size_bytes, total_turns)
       VALUES ('replay', '/tmp/reopen-fixture.oantuti', 1, 1)`
    );
    await db.query(
      `INSERT INTO result_versions (id, game_id, revision, verdict, winner, reason, disposition,
         action_trace_digest, replay_digest, manifest_digest)
       VALUES ($1, $2, 1, 'DECISIVE', 1, 'THRONE_BREACH', 'DECISIVE', 'trace', 'replay', 'manifest')`,
      [ids.versionId, ids.gameId]
    );
    await db.query(`INSERT INTO accepted_results (game_id, result_version_id) VALUES ($1, $2)`, [
      ids.gameId,
      ids.versionId,
    ]);
  });

  afterAll(async () => {
    await db.query('DELETE FROM accepted_results WHERE game_id = $1', [ids.gameId]);
    await db.query('DELETE FROM result_versions WHERE game_id = $1', [ids.gameId]);
    await db.query('DELETE FROM result_corrections WHERE game_id = $1', [ids.gameId]);
    await db.query(`DELETE FROM replay_objects WHERE digest = 'replay'`);
    await db.query('DELETE FROM games WHERE id = $1', [ids.gameId]);
    await db.query('DELETE FROM encounters WHERE id = $1', [ids.encounterId]);
    await db.query('DELETE FROM outbox_events WHERE payload->>\'tournamentId\' = $1', [ids.tournamentId]);
    await db.query('DELETE FROM audit_events WHERE resource_id = $1', [ids.tournamentId]);
    await db.query('DELETE FROM tournaments WHERE id = $1', [ids.tournamentId]);
    await db.query('DELETE FROM teams WHERE id = ANY($1::uuid[])', [[ids.teamA, ids.teamB]]);
    await db.query('DELETE FROM courses WHERE id = $1', [ids.courseId]);
    await db.query('DELETE FROM users WHERE id = $1', [ids.userId]);
    await db.close();
  });

  it('blocks corrections while FINALIZED, then allows them after reopen', async () => {
    await expect(
      corrections.previewCorrection(
        ids.gameId,
        { action: 'VOID', reason: 'finalized check', expectedRevision: 1 } as never,
        ctx
      )
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('TOURNAMENT_REOPEN_REQUIRED') });

    const reopened = await admission.reopenTournament(ids.tournamentId, ctx);
    expect(reopened.state).toBe('PROVISIONAL');
    const row = await db.query<{ state: string; finalized_at: Date | null }>(
      'SELECT state, finalized_at FROM tournaments WHERE id = $1',
      [ids.tournamentId]
    );
    expect(row.rows[0].state).toBe('PROVISIONAL');
    expect(row.rows[0].finalized_at).toBeNull();

    const preview = await corrections.previewCorrection(
      ids.gameId,
      { action: 'VOID', reason: 'reopened check', expectedRevision: 1 } as never,
      ctx
    );
    expect(preview.gameId).toBe(ids.gameId);
    expect(preview.previewDigest).toMatch(/^[a-f0-9]{64}$/);
  });
});
