import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PostgresDatabase } from '../src/persistence/db.js';
import { MapService } from '../src/tournaments/map-service.js';
import type { Actor } from '@oantuti/protocol';

/**
 * Tournament map pool (S08): the pool lists the maps a tournament may play, is admin-only, freezes
 * with the commitment at registration opening, and every change is audited.
 */
describe('S08: tournament map pool', () => {
  let db: PostgresDatabase;
  let maps: MapService;
  const ids = {
    courseId: randomUUID(),
    adminId: randomUUID(),
    draftTournament: randomUUID(),
    openTournament: randomUUID(),
  };
  const admin: Actor = {
    userId: ids.adminId,
    username: 'pool-admin',
    displayName: 'Pool Admin',
    role: 'ADMIN',
    scope: 'FULL',
    teamIds: [],
  };
  const student: Actor = { ...admin, role: 'STUDENT' };
  const slugA = `pool_a_${randomUUID().slice(0, 8)}`;
  const slugB = `pool_b_${randomUUID().slice(0, 8)}`;

  async function insertMap(slug: string): Promise<void> {
    await db.query(
      `INSERT INTO maps (id, slug, display_name, descriptor, visibility)
       VALUES ($1, $2, $3, '{}'::jsonb, 'PUBLIC')`,
      [randomUUID(), slug, `Map ${slug}`]
    );
  }

  beforeAll(async () => {
    db = new PostgresDatabase();
    maps = new MapService(db);
    await db.query(
      `INSERT INTO users (id, username, display_name, password_hash, role, activation_method)
       VALUES ($1, $2, 'Pool Admin', 'hash', 'ADMIN', 'LOCAL_BOOTSTRAP')`,
      [ids.adminId, `pool_${ids.adminId.slice(0, 8)}`]
    );
    await db.query(`INSERT INTO courses (id, code, name) VALUES ($1, $2, 'Pool Course')`, [
      ids.courseId,
      `POOL_${ids.courseId.slice(0, 8)}`,
    ]);
    for (const [tournamentId, state, name] of [
      [ids.draftTournament, 'DRAFT', 'Pool Draft'],
      [ids.openTournament, 'REGISTRATION_OPEN', 'Pool Open'],
    ] as const) {
      await db.query(
        `INSERT INTO tournaments (id, course_id, name, format, state, max_teams) VALUES ($1, $2, $3, 'SINGLE_ELIMINATION', $4, 8)`,
        [tournamentId, ids.courseId, name, state]
      );
    }
    await insertMap(slugA);
    await insertMap(slugB);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM tournament_map_pool WHERE tournament_id = ANY($1::uuid[])`, [
      [ids.draftTournament, ids.openTournament],
    ]);
    await db.query(`DELETE FROM audit_events WHERE resource_id = ANY($1::text[])`, [
      [ids.draftTournament, ids.openTournament],
    ]);
    await db.query(`DELETE FROM tournaments WHERE id = ANY($1::uuid[])`, [
      [ids.draftTournament, ids.openTournament],
    ]);
    await db.query(`DELETE FROM maps WHERE slug = ANY($1::text[])`, [[slugA, slugB]]);
    await db.query(`DELETE FROM courses WHERE id = $1`, [ids.courseId]);
    await db.query(`DELETE FROM users WHERE id = $1`, [ids.adminId]);
    await db.close();
  });

  it('adds, deduplicates and removes maps while maps can still change', async () => {
    await expect(maps.addMapToPool(ids.draftTournament, slugA, student)).rejects.toMatchObject({ statusCode: 403 });
    await expect(maps.addMapToPool(ids.draftTournament, 'no-such-map', admin)).rejects.toMatchObject({
      statusCode: 404,
    });

    await maps.addMapToPool(ids.draftTournament, slugA, admin);
    await maps.addMapToPool(ids.draftTournament, slugA, admin);
    await maps.addMapToPool(ids.draftTournament, slugB, admin);

    const pool = await maps.getTournamentMapPool(ids.draftTournament, admin);
    expect(pool.map((map) => map.slug).sort()).toEqual([slugA, slugB].sort());

    const audit = await db.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE resource_id = $1 AND action LIKE 'MAP_POOL_%'`,
      [ids.draftTournament]
    );
    expect(audit.rows.filter((row) => row.action === 'MAP_POOL_ADDED')).toHaveLength(3);

    await maps.removeMapFromPool(ids.draftTournament, slugB, admin);
    const afterRemoval = await maps.getTournamentMapPool(ids.draftTournament, admin);
    expect(afterRemoval.map((map) => map.slug)).toEqual([slugA]);
  });

  it('refuses pool edits once registration opened (MAP_FREEZE_LOCKED)', async () => {
    await expect(maps.addMapToPool(ids.openTournament, slugA, admin)).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(maps.removeMapFromPool(ids.openTournament, slugA, admin)).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});
