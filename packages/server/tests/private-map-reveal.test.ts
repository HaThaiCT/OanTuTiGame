import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { MapDescriptor } from '@oantuti/engine';
import { PostgresDatabase } from '../src/persistence/db.js';
import { resolvePrivateTestMap } from '../src/builds/private-test-runner.js';

const board = (name: string, width: number): MapDescriptor => ({
  mapName: name,
  width,
  height: 3,
  validTiles: [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2]].filter(([x]) => x < width) as [number, number][],
  whiteThrone: [0, 0],
  blackThrone: [width - 1, 2],
  startingPieces: [
    { id: 1, owner: 'WHITE', type: 'ROCK', pos: [0, 1] },
    { id: 2, owner: 'BLACK', type: 'SCISSORS', pos: [width - 1, 1] },
  ],
});

describe('private-test board resolution respects per-version reveal', () => {
  let db: PostgresDatabase;
  let tournamentId = '';
  let courseId = '';
  const run = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;

  beforeAll(async () => {
    db = new PostgresDatabase();
    const course = await db.query<{ id: string }>(
      `INSERT INTO courses (code, name) VALUES ($1, 'Private Map Course') RETURNING id`,
      [`PRIVATE_MAP_${run}`]
    );
    courseId = course.rows[0].id;
    const tournament = await db.query<{ id: string }>(
      `INSERT INTO tournaments (course_id, name, format, state) VALUES ($1, $2, 'ROUND_ROBIN', 'REGISTRATION_OPEN') RETURNING id`,
      [courseId, `Private Map Cup ${run}`]
    );
    tournamentId = tournament.rows[0].id;

    // Board A: hidden, its only version already revealed by an earlier tournament.
    const revealed = await db.query<{ id: string }>(
      `INSERT INTO maps (slug, display_name, descriptor, visibility, validation_warnings, current_version, revealed_at)
       VALUES ($1, 'Board A', $2, 'HIDDEN', '[]'::jsonb, 1, clock_timestamp()) RETURNING id`,
      [`board-a-${run}`, JSON.stringify(board('board-a', 3))]
    );
    await db.query(
      `INSERT INTO map_versions (map_id, version, descriptor, validation_warnings, revealed_at)
       VALUES ($1, 1, $2, '[]'::jsonb, clock_timestamp())`,
      [revealed.rows[0].id, JSON.stringify(board('board-a', 3))]
    );

    // Board B: created later, v1 revealed for a past tournament, v2 published afterwards and NOT
    // revealed. Its current version is the secret board of an upcoming tournament.
    const upcoming = await db.query<{ id: string }>(
      `INSERT INTO maps (slug, display_name, descriptor, visibility, validation_warnings, current_version, revealed_at)
       VALUES ($1, 'Board B', $2, 'HIDDEN', '[]'::jsonb, 2, clock_timestamp()) RETURNING id`,
      [`board-b-${run}`, JSON.stringify(board('board-b-secret', 4))]
    );
    await db.query(
      `INSERT INTO map_versions (map_id, version, descriptor, validation_warnings, revealed_at)
       VALUES ($1, 1, $2, '[]'::jsonb, clock_timestamp()), ($1, 2, $3, '[]'::jsonb, NULL)`,
      [upcoming.rows[0].id, JSON.stringify(board('board-b-old', 3)), JSON.stringify(board('board-b-secret', 4))]
    );
  });

  afterAll(async () => {
    await db.query('DELETE FROM maps WHERE slug LIKE $1', [`board-%-${run}`]);
    await db.query('DELETE FROM tournaments WHERE id = $1', [tournamentId]);
    await db.query('DELETE FROM courses WHERE id = $1', [courseId]);
    await db.close();
  });

  it('never pins a version the organizer has not revealed, even when the map was revealed before', async () => {
    const resolved = await resolvePrivateTestMap(db, tournamentId);
    // The tournament has no commitment, so the fallback picks a board: it must be the one whose
    // *current version* is revealed (Board A), never Board B's unrevealed v2.
    expect(resolved.descriptor.mapName).not.toBe('board-b-secret');
    expect(resolved.ref.source).toBe('LATEST_MAP');
    expect(resolved.ref.name).toBe('Board A');
  });
});
