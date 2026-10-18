import type { MapDescriptor } from '@oantuti/engine';
import type { Actor } from '@oantuti/protocol';
import type { PostgresDatabase } from '../persistence/db.js';
import { MapValidator, type MapValidationWarning } from './map-validator.js';

export class MapError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = 'MapError';
  }
}

export interface MapRow {
  readonly id: string;
  readonly slug: string;
  readonly display_name: string;
  readonly descriptor: MapDescriptor;
  readonly visibility: 'PUBLIC' | 'HIDDEN';
  readonly validation_warnings: readonly MapValidationWarning[];
  readonly revealed_at: string | null;
  readonly created_at: string;
}

export interface CreateMapInput {
  readonly slug: string;
  readonly displayName: string;
  readonly descriptor: MapDescriptor;
  readonly visibility?: 'PUBLIC' | 'HIDDEN';
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

    const res = await this.db.query<MapRow>(
      `INSERT INTO maps (slug, display_name, descriptor, visibility, validation_warnings)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, slug, display_name, descriptor, visibility, validation_warnings, revealed_at, created_at`,
      [
        input.slug,
        input.displayName,
        JSON.stringify(input.descriptor),
        visibility,
        JSON.stringify(validation.warnings),
      ]
    );

    return res.rows[0];
  }

  async getMap(slug: string, actor?: Actor): Promise<MapRow> {
    const res = await this.db.query<MapRow>(
      `SELECT id, slug, display_name, descriptor, visibility, validation_warnings, revealed_at, created_at
       FROM maps WHERE slug = $1`,
      [slug]
    );

    if (res.rows.length === 0) {
      throw new MapError(404, `Map not found: ${slug}`);
    }

    const map = res.rows[0];
    if (map.visibility === 'HIDDEN' && !map.revealed_at && actor?.role !== 'ADMIN') {
      throw new MapError(403, 'HIDDEN_MAP_DENIED: Map is private until tournament lock');
    }

    return map;
  }

  async listMaps(actor?: Actor): Promise<readonly MapRow[]> {
    if (actor?.role === 'ADMIN') {
      const res = await this.db.query<MapRow>(
        `SELECT id, slug, display_name, descriptor, visibility, validation_warnings, revealed_at, created_at
         FROM maps ORDER BY created_at DESC`
      );
      return res.rows;
    }

    const res = await this.db.query<MapRow>(
      `SELECT id, slug, display_name, descriptor, visibility, validation_warnings, revealed_at, created_at
       FROM maps
       WHERE visibility = 'PUBLIC' OR revealed_at IS NOT NULL
       ORDER BY created_at DESC`
    );
    return res.rows;
  }

  async addMapToPool(tournamentId: string, mapId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO tournament_map_pool (tournament_id, map_id)
       VALUES ($1, $2)
       ON CONFLICT (tournament_id, map_id) DO NOTHING`,
      [tournamentId, mapId]
    );
  }

  async getTournamentMapPool(tournamentId: string, actor?: Actor): Promise<readonly MapRow[]> {
    const res = await this.db.query<MapRow>(
      `SELECT m.id, m.slug, m.display_name, m.descriptor, m.visibility, m.validation_warnings, m.revealed_at, m.created_at
       FROM tournament_map_pool tmp
       JOIN maps m ON tmp.map_id = m.id
       WHERE tmp.tournament_id = $1
       ORDER BY m.created_at ASC`,
      [tournamentId]
    );

    if (actor?.role === 'ADMIN') return res.rows;
    return res.rows.filter((m) => m.visibility === 'PUBLIC' || m.revealed_at !== null);
  }
}
