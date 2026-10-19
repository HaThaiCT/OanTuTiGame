import { randomUUID } from 'node:crypto';
import type { MapDescriptor } from '@oantuti/engine';
import type { PoolClient } from 'pg';
import type { Actor } from '@oantuti/protocol';
import type { PostgresDatabase } from '../persistence/db.js';
import { MapValidator, type MapValidationWarning } from './map-validator.js';

export class MapError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = 'MapError';
  }
}

/** audit_events.request_id is UUID-typed while Fastify request ids are free-form. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Maps may only be committed to a tournament before registration opens. */
export const MAP_COMMITTABLE_STATES = ['DRAFT', 'PUBLISHED'] as const;

export interface MapRow {
  readonly id: string;
  readonly slug: string;
  readonly display_name: string;
  readonly descriptor: MapDescriptor;
  readonly visibility: 'PUBLIC' | 'HIDDEN';
  readonly validation_warnings: readonly MapValidationWarning[];
  readonly revealed_at: string | null;
  readonly created_at: string;
  /** Version currently pinned by `maps.descriptor` (numeric column read as `currentVersion`). */
  readonly currentVersion: number;
}

export interface CreateMapInput {
  readonly slug: string;
  readonly displayName: string;
  readonly descriptor: MapDescriptor;
  readonly visibility?: 'PUBLIC' | 'HIDDEN';
}

/** A map read resolved against one concrete `map_versions` row. */
export interface VersionedMapRow extends MapRow {
  readonly version: number;
}

export interface MapVersionPublishResult {
  readonly slug: string;
  readonly version: number;
  readonly validationWarnings: readonly MapValidationWarning[];
}

export interface MapCommitment {
  readonly tournamentId: string;
  readonly mapId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly version: number;
  readonly committedAt: string;
}

export class MapService {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly validator: MapValidator = new MapValidator()
  ) {}

  async createMap(actor: Actor, input: CreateMapInput): Promise<MapRow> {
    if (actor.role !== 'ADMIN') {
      throw new MapError(403, 'Only administrators can create maps');
    }

    const validation = this.validator.validate(input.descriptor);
    if (!validation.isValid) {
      throw new MapError(400, `Map validation failed: ${validation.errors.join('; ')}`);
    }

    const visibility = input.visibility ?? 'PUBLIC';

    // The maps row and its immutable version-1 snapshot are one atomic unit: a map without a
    // `map_versions` row could never be committed to a tournament.
    return this.db.withTransaction(async (client) => {
      const res = await client.query<MapRow>(
        `INSERT INTO maps (slug, display_name, descriptor, visibility, validation_warnings)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, slug, display_name, descriptor, visibility, validation_warnings, revealed_at, created_at,
                   current_version AS "currentVersion"`,
        [
          input.slug,
          input.displayName,
          JSON.stringify(input.descriptor),
          visibility,
          JSON.stringify(validation.warnings),
        ]
      );

      const map = res.rows[0];
      await client.query(
        `INSERT INTO map_versions (map_id, version, descriptor, validation_warnings, created_by_user_id)
         VALUES ($1, 1, $2, $3, $4)`,
        [
          map.id,
          JSON.stringify(input.descriptor),
          JSON.stringify(validation.warnings),
          actor.userId,
        ]
      );

      // Map authoring is admin-only competition configuration, so the creation is audited like the
      // pool/commit mutations below; validation warnings are recorded by count, never as free text.
      await client.query(
        `INSERT INTO audit_events (actor_user_id, action, resource_type, resource_id, request_id, details)
         VALUES ($1, 'MAP_CREATED', 'map', $2, NULL, $3)`,
        [
          actor.userId,
          map.id,
          JSON.stringify({
            slug: map.slug,
            version: 1,
            visibility,
            warningCount: validation.warnings.length,
          }),
        ]
      );

      return map;
    });
  }

  /** Publishes a new immutable version and advances the live pointer on `maps`. */
  async publishVersion(
    slug: string,
    descriptor: MapDescriptor,
    actor: Actor
  ): Promise<MapVersionPublishResult> {
    if (actor.role !== 'ADMIN') {
      throw new MapError(403, 'Only administrators can publish map versions');
    }

    const validation = this.validator.validate(descriptor);
    if (!validation.isValid) {
      throw new MapError(400, `Map validation failed: ${validation.errors.join('; ')}`);
    }

    return this.db.withTransaction(async (client) => {
      const mapRes = await client.query<{ id: string; current_version: number }>(
        `SELECT id, current_version FROM maps WHERE slug = $1 FOR UPDATE`,
        [slug]
      );

      if (mapRes.rows.length === 0) {
        throw new MapError(404, `Map not found: ${slug}`);
      }

      const { id, current_version: currentVersion } = mapRes.rows[0];
      const version = currentVersion + 1;

      await client.query(
        `INSERT INTO map_versions (map_id, version, descriptor, validation_warnings, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, version, JSON.stringify(descriptor), JSON.stringify(validation.warnings), actor.userId]
      );

      await client.query(
        `UPDATE maps
         SET descriptor = $2, validation_warnings = $3, current_version = $4
         WHERE id = $1`,
        [id, JSON.stringify(descriptor), JSON.stringify(validation.warnings), version]
      );

      // Every published version is an immutable revision of the competition map; record which
      // revision an admin published and how many warnings the validator raised for it.
      await client.query(
        `INSERT INTO audit_events (actor_user_id, action, resource_type, resource_id, request_id, details)
         VALUES ($1, 'MAP_VERSION_PUBLISHED', 'map', $2, NULL, $3)`,
        [
          actor.userId,
          id,
          JSON.stringify({ slug, version, warningCount: validation.warnings.length }),
        ]
      );

      return { slug, version, validationWarnings: validation.warnings };
    });
  }

  /** Reads the current version by default, or the exact descriptor pinned at `version`. */
  async getMap(slug: string, actor?: Actor, version?: number): Promise<VersionedMapRow> {
    const res = await this.db.query<MapRow>(
      `SELECT id, slug, display_name, descriptor, visibility, validation_warnings, revealed_at, created_at,
              current_version AS "currentVersion"
       FROM maps WHERE slug = $1`,
      [slug]
    );

    if (res.rows.length === 0) {
      throw new MapError(404, `Map not found: ${slug}`);
    }

    const map = res.rows[0];
    const targetVersion = version ?? map.currentVersion;
    const versionRes = await this.db.query<{
      descriptor: MapDescriptor;
      validation_warnings: readonly MapValidationWarning[];
      revealed_at: string | null;
    }>(
      `SELECT descriptor, validation_warnings, revealed_at
         FROM map_versions WHERE map_id = $1 AND version = $2`,
      [map.id, targetVersion]
    );

    const resolved = versionRes.rows[0];
    if (!resolved) {
      throw new MapError(404, `Map version not found: ${slug} v${targetVersion}`);
    }

    // Hidden content is gated per version, not per map: a map a tournament revealed at version N
    // keeps version N+1 secret until the tournament that pins it locks.
    if (actor?.role !== 'ADMIN' && map.visibility === 'HIDDEN' && resolved.revealed_at === null) {
      throw new MapError(403, 'HIDDEN_MAP_DENIED: Map is private until tournament lock');
    }

    return {
      ...map,
      descriptor: resolved.descriptor,
      validation_warnings: resolved.validation_warnings,
      version: targetVersion,
    };
  }

  async listMaps(actor?: Actor): Promise<readonly MapRow[]> {
    if (actor?.role === 'ADMIN') {
      const res = await this.db.query<MapRow>(
        `SELECT id, slug, display_name, descriptor, visibility, validation_warnings, revealed_at, created_at,
                current_version AS "currentVersion"
         FROM maps ORDER BY created_at DESC`
      );
      return res.rows;
    }

    // Public maps list at their current version. A hidden map is public only through what a
    // tournament actually revealed, so it lists at its newest *revealed* version and is omitted
    // while no version has been revealed.
    const res = await this.db.query<MapRow>(
      `SELECT m.id, m.slug, m.display_name, v.descriptor, m.visibility, v.validation_warnings,
              m.revealed_at, m.created_at, m.current_version AS "currentVersion"
         FROM maps m
         JOIN LATERAL (
           SELECT descriptor, validation_warnings
             FROM map_versions mv
            WHERE mv.map_id = m.id AND mv.revealed_at IS NOT NULL
            ORDER BY mv.version DESC
            LIMIT 1
         ) v ON true
        WHERE m.visibility = 'PUBLIC' OR m.revealed_at IS NOT NULL
        ORDER BY m.created_at DESC`
    );
    return res.rows;
  }

  /**
   * Adds a map to the tournament's pool. The pool is the set of maps the tournament may play
   * (knockout series need at least four), and it freezes together with the commitment at
   * registration opening, so every change is admin-only, state-guarded and audited.
   */
  async addMapToPool(tournamentId: string, slug: string, actor: Actor): Promise<void> {
    if (actor.role !== 'ADMIN') {
      throw new MapError(403, 'Only administrators can manage the tournament map pool');
    }
    await this.db.withTransaction(async (client) => {
      const map = await this.assertPoolMutable(client, tournamentId);
      const resolved = await client.query<{ id: string }>('SELECT id FROM maps WHERE slug = $1', [slug]);
      if (resolved.rows.length === 0) {
        throw new MapError(404, `Map not found: ${slug}`);
      }
      // The pool row pins the version the tournament will play (02 §153): a later publish of the same
      // map must not silently change a frozen tournament, and the knockout rotation needs a version to
      // resolve per game.
      await client.query(
        `INSERT INTO tournament_map_pool (tournament_id, map_id, map_version)
         VALUES ($1, $2, (SELECT current_version FROM maps WHERE id = $2))
         ON CONFLICT (tournament_id, map_id) DO NOTHING`,
        [map.tournamentId, resolved.rows[0].id]
      );
      await client.query(
        `INSERT INTO audit_events (actor_user_id, action, resource_type, resource_id, request_id, details)
         VALUES ($1, 'MAP_POOL_ADDED', 'tournament', $2, NULL, $3)`,
        [actor.userId, map.tournamentId, JSON.stringify({ tournamentId: map.tournamentId, slug, mapId: resolved.rows[0].id })]
      );
    });
  }

  /** Removes a map from the pool while maps can still change. */
  async removeMapFromPool(tournamentId: string, slug: string, actor: Actor): Promise<void> {
    if (actor.role !== 'ADMIN') {
      throw new MapError(403, 'Only administrators can manage the tournament map pool');
    }
    await this.db.withTransaction(async (client) => {
      const map = await this.assertPoolMutable(client, tournamentId);
      const resolved = await client.query<{ id: string }>('SELECT id FROM maps WHERE slug = $1', [slug]);
      if (resolved.rows.length === 0) {
        throw new MapError(404, `Map not found: ${slug}`);
      }
      await client.query(
        'DELETE FROM tournament_map_pool WHERE tournament_id = $1 AND map_id = $2',
        [map.tournamentId, resolved.rows[0].id]
      );
      await client.query(
        `INSERT INTO audit_events (actor_user_id, action, resource_type, resource_id, request_id, details)
         VALUES ($1, 'MAP_POOL_REMOVED', 'tournament', $2, NULL, $3)`,
        [actor.userId, map.tournamentId, JSON.stringify({ tournamentId: map.tournamentId, slug, mapId: resolved.rows[0].id })]
      );
    });
  }

  /** Locks the tournament row and refuses pool edits once maps freeze. */
  private async assertPoolMutable(client: PoolClient, tournamentId: string): Promise<{ tournamentId: string; state: string }> {
    const tourneyRes = await client.query<{ id: string; state: string }>(
      'SELECT id, state FROM tournaments WHERE id = $1 FOR UPDATE',
      [tournamentId]
    );
    const tournament = tourneyRes.rows[0];
    if (!tournament) {
      throw new MapError(404, `Tournament not found: ${tournamentId}`);
    }
    if (!(MAP_COMMITTABLE_STATES as readonly string[]).includes(tournament.state)) {
      throw new MapError(
        409,
        `MAP_FREEZE_LOCKED: maps freeze at registration opening (state '${tournament.state}')`
      );
    }
    return { tournamentId: tournament.id, state: tournament.state };
  }

  async getTournamentMapPool(tournamentId: string, actor?: Actor): Promise<readonly MapRow[]> {
    // The pool is read at the version the tournament pinned, never at whatever the map shows now: a
    // later publish must not change a frozen choice, and it must not become visible through it.
    const res = await this.db.query<MapRow & { version_revealed_at: string | null }>(
      `SELECT m.id, m.slug, m.display_name, m.visibility, m.revealed_at, m.created_at,
              m.current_version AS "currentVersion",
              coalesce(v.descriptor, m.descriptor) AS descriptor,
              coalesce(v.validation_warnings, m.validation_warnings) AS validation_warnings,
              v.revealed_at AS version_revealed_at
         FROM tournament_map_pool p
         JOIN maps m ON p.map_id = m.id
         LEFT JOIN map_versions v ON v.map_id = p.map_id AND v.version = p.map_version
        WHERE p.tournament_id = $1
        ORDER BY m.created_at ASC`,
      [tournamentId]
    );

    const entries = res.rows.map((row) => ({
      versionRevealed: row.version_revealed_at !== null,
      row: {
        id: row.id,
        slug: row.slug,
        display_name: row.display_name,
        descriptor: row.descriptor,
        visibility: row.visibility,
        validation_warnings: row.validation_warnings,
        revealed_at: row.revealed_at,
        created_at: row.created_at,
        currentVersion: row.currentVersion,
      } satisfies MapRow,
    }));

    if (actor?.role === 'ADMIN') return entries.map((entry) => entry.row);
    return entries
      .filter((entry) => entry.row.visibility === 'PUBLIC' || entry.versionRevealed)
      .map((entry) => entry.row);
  }

  /**
   * Pins the map's *current* version to a tournament. Only allowed while the tournament can still
   * change its map (DRAFT/PUBLISHED); registration opening freezes the choice.
   */
  async commitMapForTournament(
    tournamentId: string,
    slug: string,
    actor: Actor
  ): Promise<{ tournamentId: string; slug: string; version: number; committedAt: string }> {
    if (actor.role !== 'ADMIN') {
      throw new MapError(403, 'Only administrators can commit a map for a tournament');
    }

    return this.db.withTransaction(async (client) => {
      const tourneyRes = await client.query<{ id: string; state: string }>(
        `SELECT id, state FROM tournaments WHERE id = $1 FOR UPDATE`,
        [tournamentId]
      );

      if (tourneyRes.rows.length === 0) {
        throw new MapError(404, `Tournament not found: ${tournamentId}`);
      }

      const state = tourneyRes.rows[0].state;
      if (!(MAP_COMMITTABLE_STATES as readonly string[]).includes(state)) {
        throw new MapError(
          409,
          `MAP_FREEZE_LOCKED: maps freeze at registration opening (state '${state}')`
        );
      }

      const mapRes = await client.query<{ id: string; current_version: number }>(
        `SELECT id, current_version FROM maps WHERE slug = $1`,
        [slug]
      );

      if (mapRes.rows.length === 0) {
        throw new MapError(404, `Map not found: ${slug}`);
      }

      const map = mapRes.rows[0];

      const commitRes = await client.query<{ committed_at: Date }>(
        `INSERT INTO tournament_map_commitments
           (tournament_id, map_id, map_version, committed_by_user_id, committed_at)
         VALUES ($1, $2, $3, $4, clock_timestamp())
         ON CONFLICT (tournament_id) DO UPDATE
           SET map_id = EXCLUDED.map_id,
               map_version = EXCLUDED.map_version,
               committed_by_user_id = EXCLUDED.committed_by_user_id,
               committed_at = EXCLUDED.committed_at
         RETURNING committed_at`,
        [tournamentId, map.id, map.current_version, actor.userId]
      );

      await client.query(
        `INSERT INTO audit_events (actor_user_id, action, resource_type, resource_id, request_id, details)
         VALUES ($1, 'MAP_COMMITTED', 'tournament', $2, NULL, $3)`,
        [
          actor.userId,
          tournamentId,
          JSON.stringify({ tournamentId, mapId: map.id, slug, version: map.current_version }),
        ]
      );

      const committedAt = commitRes.rows[0].committed_at;

      return {
        tournamentId,
        slug,
        version: map.current_version,
        committedAt: committedAt instanceof Date ? committedAt.toISOString() : String(committedAt),
      };
    });
  }

  async getMapCommitment(tournamentId: string): Promise<MapCommitment | null> {
    const res = await this.db.query<{
      tournament_id: string;
      map_id: string;
      slug: string;
      display_name: string;
      map_version: number;
      committed_at: Date;
    }>(
      `SELECT c.tournament_id, c.map_id, m.slug, m.display_name, c.map_version, c.committed_at
       FROM tournament_map_commitments c
       JOIN maps m ON m.id = c.map_id
       WHERE c.tournament_id = $1`,
      [tournamentId]
    );

    const row = res.rows[0];
    if (!row) return null;

    return {
      tournamentId: row.tournament_id,
      mapId: row.map_id,
      slug: row.slug,
      displayName: row.display_name,
      version: row.map_version,
      committedAt: row.committed_at instanceof Date ? row.committed_at.toISOString() : String(row.committed_at),
    };
  }

  /** Audit note for a start that fell back to an ad-hoc mapSlug instead of a frozen commitment. */
  async recordMapUsedWithoutCommitment(
    tournamentId: string,
    actor: Actor,
    requestId?: string
  ): Promise<void> {
    const correlationId = requestId && UUID_PATTERN.test(requestId) ? requestId : randomUUID();

    await this.db.query(
      `INSERT INTO audit_events (actor_user_id, action, resource_type, resource_id, request_id, details)
       VALUES ($1, 'MAP_USED_WITHOUT_COMMITMENT', 'tournament', $2, $3, $4)`,
      [actor.userId, tournamentId, correlationId, JSON.stringify({ tournamentId })]
    );
  }
}
