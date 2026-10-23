import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { MapDescriptor } from '@oantuti/engine';
import type { Actor, CommandContext } from '@oantuti/protocol';
import { createApp } from '../src/app.js';
import { PostgresDatabase } from '../src/persistence/db.js';
import { IdentityService } from '../src/identity/service.js';
import { hashPassword } from '../src/identity/crypto.js';
import { MapService, MapError } from '../src/tournaments/map-service.js';
import { TournamentLifecycleService } from '../src/tournaments/lifecycle-service.js';

const previousDevExecution = process.env.OANTUTI_DEV_EXECUTION;
const MAP_V1: MapDescriptor = {
  mapName: 'map-versions-v1',
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

const MAP_V2: MapDescriptor = { ...MAP_V1, mapName: 'map-versions-v2' };
const MAP_V3: MapDescriptor = { ...MAP_V1, mapName: 'map-versions-v3' };

/** Too small for MapValidator, so the service rejects it with its verbatim message. */
const INVALID_DESCRIPTOR: MapDescriptor = {
  ...MAP_V1,
  mapName: 'map-versions-invalid',
  width: 2,
  height: 2,
  validTiles: [
    [0, 0], [1, 0],
    [0, 1], [1, 1],
  ],
  blackThrone: [1, 1],
};

describe('S16: Map versions & tournament map commitments', () => {
  let app: FastifyInstance;
  let db: PostgresDatabase;
  let mapService: MapService;
  let identityService: IdentityService;

  const runId = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const adminUsername = `mapver_admin_${runId}`;
  const adminPassword = 'map-version-password-123';

  const versionedSlug = `mapver_versioned_${runId}`;
  const plainSlug = `mapver_plain_${runId}`;

  let adminActor: Actor;
  let adminCookie: string;
  let courseId: string;
  let teamAId: string;
  let teamBId: string;
  let adminUserId: string;
  let captainAId: string;
  let captainBId: string;

  let tDraft: string;
  let tOpen: string;
  let tPublished: string;
  let tPlain: string;

  async function insertTournament(state: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `INSERT INTO tournaments (course_id, name, format, state)
       VALUES ($1, $2, 'ROUND_ROBIN', $3) RETURNING id`,
      [courseId, `MapVersions Cup ${runId} ${state}`, state]
    );
    const id = res.rows[0].id;
    await db.query(
      `INSERT INTO tournament_entries (tournament_id, team_id, status, seed_ordinal)
       VALUES ($1, $2, 'ELIGIBLE', 1), ($1, $3, 'ELIGIBLE', 2)`,
      [id, teamAId, teamBId]
    );
    return id;
  }

  beforeAll(async () => {
    process.env.OANTUTI_DEV_EXECUTION = '1';
    db = new PostgresDatabase();
    mapService = new MapService(db);
    identityService = new IdentityService(db);

    const appCtx = await createApp({ pgDb: db });
    app = appCtx.app;

    // Admin identity: session cookie derived through the real login path.
    const adminRes = await db.query<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
       VALUES ($1, 'Map Version Admin', $2, 'ADMIN', 'LOCAL_BOOTSTRAP', FALSE) RETURNING id`,
      [adminUsername, await hashPassword(adminPassword)]
    );
    adminUserId = adminRes.rows[0].id;
    const session = await identityService.login(adminUsername, adminPassword);
    adminCookie = `oantuti_session=${session.token}`;
    // `/start` is a destructive action: it needs a password confirmation for this session
    // (migration 016), otherwise it answers 403 REAUTH_REQUIRED.
    const reauth = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/reauth',
      headers: { cookie: adminCookie, origin: process.env.OANTUTI_PUBLIC_BASE_URL ?? 'http://localhost:3000' },
      payload: { password: adminPassword },
    });
    expect(reauth.statusCode, reauth.body).toBe(200);
    adminActor = {
      userId: adminUserId,
      role: 'ADMIN',
      username: adminUsername,
      teamIds: [],
      scope: 'FULL',
    };

    const courseRes = await db.query<{ id: string }>(
      `INSERT INTO courses (code, name) VALUES ($1, 'Map Versions Course') RETURNING id`,
      [`MAPVER_${runId}`]
    );
    courseId = courseRes.rows[0].id;

    const capA = await db.query<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
       VALUES ($1, 'Captain A', 'hash', 'STUDENT', 'ADMIN_ISSUED', FALSE) RETURNING id`,
      [`mapver_cap_a_${runId}`]
    );
    captainAId = capA.rows[0].id;
    const capB = await db.query<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
       VALUES ($1, 'Captain B', 'hash', 'STUDENT', 'ADMIN_ISSUED', FALSE) RETURNING id`,
      [`mapver_cap_b_${runId}`]
    );
    captainBId = capB.rows[0].id;

    const teamA = await db.query<{ id: string }>(
      `INSERT INTO teams (course_id, name, captain_user_id) VALUES ($1, $2, $3) RETURNING id`,
      [courseId, `Rooks ${runId}`, captainAId]
    );
    teamAId = teamA.rows[0].id;
    const teamB = await db.query<{ id: string }>(
      `INSERT INTO teams (course_id, name, captain_user_id) VALUES ($1, $2, $3) RETURNING id`,
      [courseId, `Bishops ${runId}`, captainBId]
    );
    teamBId = teamB.rows[0].id;

    tDraft = await insertTournament('DRAFT');
    tOpen = await insertTournament('REGISTRATION_OPEN');
    tPublished = await insertTournament('PUBLISHED');
    tPlain = await insertTournament('READY_TO_START');
  });

  afterAll(async () => {
    await app.close();
    const tournamentIds = [tDraft, tOpen, tPublished, tPlain];
    await db.query(`DELETE FROM audit_events WHERE resource_id = ANY($1::text[])`, [tournamentIds]);
    await db.query(`DELETE FROM jobs WHERE payload->>'tournamentId' = ANY($1::text[])`, [tournamentIds]);
    await db.query(`DELETE FROM outbox_events WHERE payload->>'tournamentId' = ANY($1::text[])`, [tournamentIds]);
    await db.query(`DELETE FROM tournaments WHERE id = ANY($1::uuid[])`, [tournamentIds]);
    await db.query(`DELETE FROM maps WHERE slug = ANY($1::text[])`, [[versionedSlug, plainSlug]]);
    await db.query(`DELETE FROM teams WHERE id = ANY($1::uuid[])`, [[teamAId, teamBId]]);
    await db.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[adminUserId, captainAId, captainBId]]);
    await db.query(`DELETE FROM courses WHERE id = $1`, [courseId]);
    await db.close();
  });
  describe('1. Version creation and versioned reads', () => {
    it('createMap publishes version 1 in the same transaction', async () => {
      const created = await mapService.createMap(adminActor, {
        slug: versionedSlug,
        displayName: 'Versioned Arena',
        descriptor: MAP_V1,
      });
      expect(created.currentVersion).toBe(1);

      const versions = await db.query<{ version: number; descriptor: MapDescriptor }>(
        `SELECT mv.version, mv.descriptor
         FROM map_versions mv JOIN maps m ON m.id = mv.map_id
         WHERE m.slug = $1 ORDER BY mv.version`,
        [versionedSlug]
      );
      expect(versions.rows).toHaveLength(1);
      expect(versions.rows[0].version).toBe(1);
      expect(versions.rows[0].descriptor.mapName).toBe(MAP_V1.mapName);

      const read = await mapService.getMap(versionedSlug, adminActor);
      expect(read.version).toBe(1);
      expect(read.currentVersion).toBe(1);
      expect(read.descriptor.mapName).toBe(MAP_V1.mapName);
    });

    it('publishVersion creates v2, syncs the live pointer, and keeps v1 readable', async () => {
      const published = await mapService.publishVersion(versionedSlug, MAP_V2, adminActor);
      expect(published).toEqual({ slug: versionedSlug, version: 2, validationWarnings: [] });

      const current = await mapService.getMap(versionedSlug, adminActor);
      expect(current.version).toBe(2);
      expect(current.currentVersion).toBe(2);
      expect(current.descriptor.mapName).toBe(MAP_V2.mapName);

      const pinned = await mapService.getMap(versionedSlug, adminActor, 1);
      expect(pinned.version).toBe(1);
      expect(pinned.descriptor.mapName).toBe(MAP_V1.mapName);

      const liveRow = await db.query<{ current_version: number; descriptor: MapDescriptor }>(
        `SELECT current_version, descriptor FROM maps WHERE slug = $1`,
        [versionedSlug]
      );
      expect(liveRow.rows[0].current_version).toBe(2);
      expect(liveRow.rows[0].descriptor.mapName).toBe(MAP_V2.mapName);
    });

    it('rejects unknown versions, invalid descriptors, and non-admin publishers', async () => {
      await expect(mapService.getMap(versionedSlug, adminActor, 99)).rejects.toThrowError(
        new MapError(404, `Map version not found: ${versionedSlug} v99`)
      );

      await expect(mapService.publishVersion(versionedSlug, INVALID_DESCRIPTOR, adminActor)).rejects.toThrowError(
        /Map validation failed: Dimensions too small/
      );

      const playerActor: Actor = {
        userId: captainAId,
        role: 'STUDENT',
        username: `mapver_cap_a_${runId}`,
        teamIds: [teamAId],
        scope: 'FULL',
      };
      await expect(mapService.publishVersion(versionedSlug, MAP_V3, playerActor)).rejects.toThrowError(
        new MapError(403, 'Only administrators can publish map versions')
      );
    });
  });

  describe('2. Tournament map commitments', () => {
    it('commits the current version of a PUBLISHED tournament and audits MAP_COMMITTED', async () => {
      const commitment = await mapService.commitMapForTournament(tPublished, versionedSlug, adminActor);
      expect(commitment.slug).toBe(versionedSlug);
      expect(commitment.version).toBe(2);
      expect(new Date(commitment.committedAt).toString()).not.toBe('Invalid Date');

      const stored = await mapService.getMapCommitment(tPublished);
      expect(stored).not.toBeNull();
      expect(stored?.slug).toBe(versionedSlug);
      expect(stored?.displayName).toBe('Versioned Arena');
      expect(stored?.version).toBe(2);

      const audit = await db.query<{ details: { version: number } }>(
        `SELECT details FROM audit_events WHERE action = 'MAP_COMMITTED' AND resource_id = $1`,
        [tPublished]
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].details.version).toBe(2);
    });

    it('refuses to commit once registration is open', async () => {
      await expect(
        mapService.commitMapForTournament(tOpen, versionedSlug, adminActor)
      ).rejects.toThrowError(
        new MapError(
          409,
          "MAP_FREEZE_LOCKED: maps freeze at registration opening (state 'REGISTRATION_OPEN')"
        )
      );
      expect(await mapService.getMapCommitment(tOpen)).toBeNull();
    });
  });

  describe('3. HTTP surface', () => {
    it('POST /api/v2/organizer/maps/:slug/versions returns 201 and surfaces validation errors verbatim', async () => {
      const published = await app.inject({
        method: 'POST',
        url: `/api/v2/organizer/maps/${versionedSlug}/versions`,
        headers: { cookie: adminCookie, origin: process.env.OANTUTI_PUBLIC_BASE_URL ?? 'http://localhost:3000', 'content-type': 'application/json' },
        payload: { descriptor: MAP_V3 },
      });
      expect(published.statusCode).toBe(201);
      expect(published.json()).toEqual({ slug: versionedSlug, version: 3, validationWarnings: [] });

      const invalid = await app.inject({
        method: 'POST',
        url: `/api/v2/organizer/maps/${versionedSlug}/versions`,
        headers: { cookie: adminCookie, origin: process.env.OANTUTI_PUBLIC_BASE_URL ?? 'http://localhost:3000', 'content-type': 'application/json' },
        payload: { descriptor: INVALID_DESCRIPTOR },
      });
      expect(invalid.statusCode).toBe(400);
      expect(String(invalid.json().error)).toMatch(/Map validation failed: Dimensions too small/);

      const unauthenticated = await app.inject({
        method: 'POST',
        url: `/api/v2/organizer/maps/${versionedSlug}/versions`,
        headers: { 'content-type': 'application/json', origin: process.env.OANTUTI_PUBLIC_BASE_URL ?? 'http://localhost:3000' },
        payload: { descriptor: MAP_V1 },
      });
      expect(unauthenticated.statusCode).toBe(401);
    });

    it('GET /api/v2/maps/:slug pins the requested version', async () => {
      const current = await app.inject({ method: 'GET', url: `/api/v2/maps/${versionedSlug}` });
      expect(current.statusCode).toBe(200);
      expect(current.json().version).toBe(3);
      expect(current.json().descriptor.mapName).toBe(MAP_V3.mapName);

      const pinnedV1 = await app.inject({ method: 'GET', url: `/api/v2/maps/${versionedSlug}?version=1` });
      expect(pinnedV1.statusCode).toBe(200);
      expect(pinnedV1.json().version).toBe(1);
      expect(pinnedV1.json().descriptor.mapName).toBe(MAP_V1.mapName);

      const unknown = await app.inject({ method: 'GET', url: `/api/v2/maps/${versionedSlug}?version=42` });
      expect(unknown.statusCode).toBe(404);

      const malformed = await app.inject({ method: 'GET', url: `/api/v2/maps/${versionedSlug}?version=two` });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json()).toEqual({ error: 'INVALID_VERSION' });
    });

    it('exposes the commitment via organizer POST and public GET', async () => {
      const missingSlug = await app.inject({
        method: 'POST',
        url: `/api/v2/organizer/tournaments/${tDraft}/map-commitment`,
        headers: { cookie: adminCookie, origin: process.env.OANTUTI_PUBLIC_BASE_URL ?? 'http://localhost:3000', 'content-type': 'application/json' },
        payload: {},
      });
      expect(missingSlug.statusCode).toBe(400);

      const hiddenDraft = await app.inject({
        method: 'GET',
        url: `/api/v2/tournaments/${tDraft}/map-commitment`,
      });
      expect(hiddenDraft.statusCode).toBe(404);

      const unknownTournament = await app.inject({
        method: 'GET',
        url: '/api/v2/tournaments/00000000-0000-4000-8000-000000000000/map-commitment',
      });
      expect(unknownTournament.statusCode).toBe(404);

      const committed = await app.inject({
        method: 'POST',
        url: `/api/v2/organizer/tournaments/${tDraft}/map-commitment`,
        headers: { cookie: adminCookie, origin: process.env.OANTUTI_PUBLIC_BASE_URL ?? 'http://localhost:3000', 'content-type': 'application/json' },
        payload: { slug: versionedSlug },
      });
      expect(committed.statusCode).toBe(200);
      expect(committed.json().version).toBe(3);

      // A DRAFT tournament stays invisible even after a commitment is recorded.
      const stillDraft = await app.inject({
        method: 'GET',
        url: `/api/v2/tournaments/${tDraft}/map-commitment`,
      });
      expect(stillDraft.statusCode).toBe(404);

      const exposed = await app.inject({
        method: 'GET',
        url: `/api/v2/tournaments/${tPublished}/map-commitment`,
      });
      expect(exposed.statusCode).toBe(200);
      expect(exposed.json().commitment.slug).toBe(versionedSlug);
      expect(exposed.json().commitment.version).toBe(2);

      const lockedOpen = await app.inject({
        method: 'POST',
        url: `/api/v2/organizer/tournaments/${tOpen}/map-commitment`,
        headers: { cookie: adminCookie, origin: process.env.OANTUTI_PUBLIC_BASE_URL ?? 'http://localhost:3000', 'content-type': 'application/json' },
        payload: { slug: versionedSlug },
      });
      expect(lockedOpen.statusCode).toBe(409);
      expect(String(lockedOpen.json().error)).toContain('MAP_FREEZE_LOCKED');

      const openWithoutCommitment = await app.inject({
        method: 'GET',
        url: `/api/v2/tournaments/${tOpen}/map-commitment`,
      });
      expect(openWithoutCommitment.statusCode).toBe(200);
      expect(openWithoutCommitment.json()).toEqual({ commitment: null });
    });
  });

  describe('4. Start contract', () => {
    it('uses the committed version descriptor and rejects a mismatched slug', async () => {
      // Registration opening already froze the commitment at version 2; version 3 is live now.
      await db.query(`UPDATE tournaments SET state = 'READY_TO_START' WHERE id = $1`, [tPublished]);
      // Round-robin needs at least one map in the frozen pool before it can start.
      await db.query(
        `INSERT INTO tournament_map_pool (tournament_id, map_id)
         SELECT $1, id FROM maps WHERE slug = $2
         ON CONFLICT (tournament_id, map_id) DO NOTHING`,
        [tPublished, versionedSlug]
      );

      const mismatch = await app.inject({
        method: 'POST',
        url: `/api/v2/organizer/tournaments/${tPublished}/start`,
        headers: { cookie: adminCookie, origin: process.env.OANTUTI_PUBLIC_BASE_URL ?? 'http://localhost:3000', 'content-type': 'application/json' },
        payload: { mapSlug: plainSlug },
      });
      expect(mismatch.statusCode).toBe(409);
      expect(mismatch.json()).toEqual({ error: 'MAP_COMMITMENT_MISMATCH' });

      const started = await app.inject({
        method: 'POST',
        url: `/api/v2/organizer/tournaments/${tPublished}/start`,
        headers: { cookie: adminCookie, origin: process.env.OANTUTI_PUBLIC_BASE_URL ?? 'http://localhost:3000', 'content-type': 'application/json' },
        payload: {},
      });
      expect(started.statusCode).toBe(200);
      expect(started.json().data.state).toBe('RUNNING');

      const scheduled = await db.query<{ map_name: string }>(
        `SELECT g.map_descriptor->>'mapName' AS map_name
         FROM games g
         JOIN encounters e ON e.id = g.encounter_id
         WHERE e.tournament_id = $1`,
        [tPublished]
      );
      expect(scheduled.rows.length).toBeGreaterThan(0);
      for (const row of scheduled.rows) {
        expect(row.map_name).toBe(MAP_V2.mapName);
      }

      const note = await db.query<{ action: string }>(
        `SELECT action FROM audit_events WHERE resource_id = $1 AND action = 'MAP_USED_WITHOUT_COMMITMENT'`,
        [tPublished]
      );
      expect(note.rows).toHaveLength(0);
    });

    it('keeps the uncommitted behaviour and records MAP_USED_WITHOUT_COMMITMENT', async () => {
      await mapService.createMap(adminActor, {
        slug: plainSlug,
        displayName: 'Uncommitted Arena',
        descriptor: MAP_V1,
      });

      await db.query(
        `INSERT INTO tournament_map_pool (tournament_id, map_id)
         SELECT $1, id FROM maps WHERE slug = $2
         ON CONFLICT (tournament_id, map_id) DO NOTHING`,
        [tPlain, plainSlug]
      );

      const noSlug = await app.inject({
        method: 'POST',
        url: `/api/v2/organizer/tournaments/${tPlain}/start`,
        headers: { cookie: adminCookie, origin: process.env.OANTUTI_PUBLIC_BASE_URL ?? 'http://localhost:3000', 'content-type': 'application/json' },
        payload: {},
      });
      expect(noSlug.statusCode).toBe(400);
      expect(noSlug.json()).toEqual({ error: 'MAP_REQUIRED' });

      const started = await app.inject({
        method: 'POST',
        url: `/api/v2/organizer/tournaments/${tPlain}/start`,
        headers: { cookie: adminCookie, origin: process.env.OANTUTI_PUBLIC_BASE_URL ?? 'http://localhost:3000', 'content-type': 'application/json' },
        payload: { mapSlug: plainSlug },
      });
      expect(started.statusCode).toBe(200);
      expect(started.json().data.state).toBe('RUNNING');

      const note = await db.query<{ details: { tournamentId: string } }>(
        `SELECT details FROM audit_events
         WHERE resource_id = $1 AND action = 'MAP_USED_WITHOUT_COMMITMENT'`,
        [tPlain]
      );
      expect(note.rows).toHaveLength(1);
      expect(note.rows[0].details.tournamentId).toBe(tPlain);
    });
  });

  describe('5. Hidden content is gated per version, not per map', () => {
    it('keeps a later version secret until the tournament that pins it locks', async () => {
      const hiddenSlug = `mapver_hidden_${runId}`;
      const secretV1: MapDescriptor = { ...MAP_V1, mapName: `${hiddenSlug}-v1` };
      const secretV2: MapDescriptor = { ...MAP_V2, mapName: `${hiddenSlug}-v2` };
      const tReveal = await insertTournament('PUBLISHED');
      const tFuture = await insertTournament('PUBLISHED');
      const lifecycle = new TournamentLifecycleService(db);
      const ctx: CommandContext = { actor: adminActor, requestId: randomUUID() };

      try {
        await mapService.createMap(adminActor, {
          slug: hiddenSlug,
          displayName: 'Secret Board',
          descriptor: secretV1,
          visibility: 'HIDDEN',
        });
        await mapService.commitMapForTournament(tReveal, hiddenSlug, adminActor);
        // Locking the first tournament reveals exactly the version it pinned.
        await lifecycle.lock(tReveal, ctx);

        // A newer version becomes the secret board of a tournament that has not locked yet.
        await mapService.publishVersion(hiddenSlug, secretV2, adminActor);
        await mapService.addMapToPool(tFuture, hiddenSlug, adminActor);

        // Neither the default read nor an explicit request for the new version may serve it.
        await expect(mapService.getMap(hiddenSlug)).rejects.toMatchObject({ statusCode: 403 });
        await expect(mapService.getMap(hiddenSlug, undefined, 2)).rejects.toMatchObject({ statusCode: 403 });
        const revealedV1 = await mapService.getMap(hiddenSlug, undefined, 1);
        expect(revealedV1.descriptor.mapName).toBe(secretV1.mapName);

        // The organizer still reads the current version.
        const adminRead = await mapService.getMap(hiddenSlug, adminActor);
        expect(adminRead.descriptor.mapName).toBe(secretV2.mapName);

        // The public listing shows what was revealed, never what is still secret.
        const listed = (await mapService.listMaps()).find((row) => row.slug === hiddenSlug);
        expect(listed?.descriptor.mapName).toBe(secretV1.mapName);

        // The future tournament's pool must not expose the version it pinned.
        expect(await mapService.getTournamentMapPool(tFuture)).toEqual([]);
        const adminPool = await mapService.getTournamentMapPool(tFuture, adminActor);
        expect(adminPool.map((row) => row.descriptor.mapName)).toEqual([secretV2.mapName]);

        // Locking that tournament reveals its own version.
        await lifecycle.lock(tFuture, ctx);
        const afterSecondLock = await mapService.getMap(hiddenSlug);
        expect(afterSecondLock.descriptor.mapName).toBe(secretV2.mapName);
      } finally {
        const tournamentIds = [tReveal, tFuture];
        await db.query(`DELETE FROM tournament_map_pool WHERE tournament_id = ANY($1::uuid[])`, [tournamentIds]);
        await db.query(`DELETE FROM outbox_events WHERE payload->>'tournamentId' = ANY($1::text[])`, [tournamentIds]);
        await db.query(`DELETE FROM audit_events WHERE resource_id = ANY($1::text[])`, [tournamentIds]);
        await db.query(`DELETE FROM tournaments WHERE id = ANY($1::uuid[])`, [tournamentIds]);
        await db.query(`DELETE FROM maps WHERE slug = $1`, [hiddenSlug]);
      }
    });
  });
});
afterAll(() => {
  if (previousDevExecution === undefined) delete process.env.OANTUTI_DEV_EXECUTION;
  else process.env.OANTUTI_DEV_EXECUTION = previousDevExecution;
});
