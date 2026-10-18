import { randomInt, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { CommandContext } from '@oantuti/protocol';
import type { PostgresDatabase } from '../persistence/db.js';
import { hashToken } from '../identity/crypto.js';

/** Visually ambiguous glyphs (I, O, 0, 1) are excluded so a code survives being read aloud. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_GROUPS = 4;
const CODE_GROUP_LENGTH = 4;
const DEFAULT_MAX_USES = 100;
const MAX_MAX_USES = 10000;
/** Tournament states that accept new teams, mirroring direct enrollment. */
const JOINABLE_STATES = ['REGISTRATION_OPEN', 'VALIDATING_SUBMISSIONS'];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * audit_events.request_id is UUID-typed while Fastify request ids are free-form,
 * so non-UUID request ids are replaced by a generated correlation id.
 */
function auditRequestId(requestId: string | undefined): string {
  return requestId && UUID_PATTERN.test(requestId) ? requestId : randomUUID();
}

export class EntryCodeError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    /** Machine-readable discriminator surfaced to the caller. */
    readonly code: string
  ) {
    super(message);
    this.name = 'EntryCodeError';
  }
}

export interface CreateEntryCodeInput {
  readonly maxUses?: number;
  readonly expiresAt?: string;
}

export interface EntryCodeCreated {
  /** Plaintext code, returned exactly once; only its SHA-256 hash is stored. */
  readonly code: string;
  readonly maxUses: number;
  readonly expiresAt: string | null;
}

export interface EntryCodeSummary {
  readonly id: string;
  readonly maxUses: number;
  readonly uses: number;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

export interface EntryCodeJoinReceipt {
  readonly id: string;
  readonly tournamentId: string;
  readonly teamId: string;
  readonly status: string;
}

/** Formats a human-transcribable code such as `K7QM-3XBP-9TFA-2WRL`. */
export function generateEntryCode(): string {
  const groups: string[] = [];
  for (let group = 0; group < CODE_GROUPS; group += 1) {
    let chunk = '';
    for (let position = 0; position < CODE_GROUP_LENGTH; position += 1) {
      chunk += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    }
    groups.push(chunk);
  }
  return groups.join('-');
}

/** Uppercases and drops separators so `k7qm 3xbp9tfa2wrl` matches `K7QM-3XBP-9TFA-2WRL`. */
export function normalizeEntryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Shared multi-use tournament entry codes (migration 013). A code admits the
 * caller's team through `tournament_admissions`/`tournament_entries` and burns
 * one use inside the same transaction, so capacity and exhaustion cannot race.
 */
export class TournamentEntryCodeService {
  constructor(private readonly db: PostgresDatabase) {}

  async createCode(
    tournamentId: string,
    input: CreateEntryCodeInput,
    ctx: CommandContext
  ): Promise<EntryCodeCreated> {
    if (ctx.actor.role !== 'ADMIN') {
      throw new EntryCodeError(403, 'Only administrators can issue entry codes', 'FORBIDDEN');
    }
    const maxUses = input.maxUses ?? DEFAULT_MAX_USES;
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > MAX_MAX_USES) {
      throw new EntryCodeError(400, `maxUses must be an integer between 1 and ${MAX_MAX_USES}`, 'INVALID_MAX_USES');
    }
    let expiresAt: Date | null = null;
    if (input.expiresAt !== undefined && input.expiresAt !== null) {
      expiresAt = new Date(input.expiresAt);
      if (Number.isNaN(expiresAt.getTime())) {
        throw new EntryCodeError(400, 'expiresAt must be an ISO-8601 timestamp', 'INVALID_EXPIRES_AT');
      }
    }
    const requestId = auditRequestId(ctx.requestId);
    const code = generateEntryCode();
    const codeHash = hashToken(normalizeEntryCode(code));

    return this.db.withTransaction(async (client) => {
      const tournament = await client.query<{ id: string }>('SELECT id FROM tournaments WHERE id = $1', [tournamentId]);
      if (tournament.rows.length === 0) {
        throw new EntryCodeError(404, `Tournament not found: ${tournamentId}`, 'TOURNAMENT_NOT_FOUND');
      }

      const clash = await client.query('SELECT 1 FROM tournament_entry_codes WHERE code_hash = $1', [codeHash]);
      if (clash.rows.length > 0) {
        throw new EntryCodeError(500, 'Failed to allocate a unique entry code', 'CODE_ALLOCATION_FAILED');
      }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO tournament_entry_codes (tournament_id, code_hash, max_uses, expires_at, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [tournamentId, codeHash, maxUses, expiresAt, ctx.actor.userId]
      );

      await this.recordAudit(client, ctx, requestId, 'ENTRY_CODE_CREATED', tournamentId, {
        entryCodeId: inserted.rows[0].id,
        maxUses,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
      });

      return { code, maxUses, expiresAt: expiresAt ? expiresAt.toISOString() : null };
    });
  }

  async listCodes(tournamentId: string, ctx: CommandContext): Promise<EntryCodeSummary[]> {
    if (ctx.actor.role !== 'ADMIN') {
      throw new EntryCodeError(403, 'Only administrators can list entry codes', 'FORBIDDEN');
    }
    const tournament = await this.db.query<{ id: string }>('SELECT id FROM tournaments WHERE id = $1', [tournamentId]);
    if (tournament.rows.length === 0) {
      throw new EntryCodeError(404, `Tournament not found: ${tournamentId}`, 'TOURNAMENT_NOT_FOUND');
    }

    const res = await this.db.query<{
      id: string;
      max_uses: number;
      uses: number;
      expires_at: Date | null;
      created_at: Date;
    }>(
      `SELECT id, max_uses, uses, expires_at, created_at
       FROM tournament_entry_codes
       WHERE tournament_id = $1
       ORDER BY created_at DESC`,
      [tournamentId]
    );

    return res.rows.map((row) => ({
      id: row.id,
      maxUses: row.max_uses,
      uses: row.uses,
      expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
      createdAt: row.created_at.toISOString(),
    }));
  }

  /**
   * Admits a team with a shared code. The caller must be that team's captain or
   * an administrator; capacity, duplicates and the use counter are all resolved
   * under the tournament row lock.
   */
  async joinWithCode(
    tournamentId: string,
    input: { readonly code: string; readonly teamId: string },
    ctx: CommandContext
  ): Promise<EntryCodeJoinReceipt> {
    const teamId = typeof input.teamId === 'string' ? input.teamId.trim() : '';
    if (!teamId) {
      throw new EntryCodeError(400, 'teamId is required', 'INVALID_TEAM_ID');
    }
    const normalized = normalizeEntryCode(typeof input.code === 'string' ? input.code : '');
    if (!normalized) {
      throw new EntryCodeError(400, 'code is required', 'ENTRY_CODE_INVALID');
    }
    const codeHash = hashToken(normalized);
    const requestId = auditRequestId(ctx.requestId);

    return this.db.withTransaction(async (client) => {
      const tournamentRes = await client.query<{ id: string; state: string; max_teams: number }>(
        'SELECT id, state, max_teams FROM tournaments WHERE id = $1 FOR UPDATE',
        [tournamentId]
      );
      const tournament = tournamentRes.rows[0];
      if (!tournament) {
        throw new EntryCodeError(404, `Tournament not found: ${tournamentId}`, 'TOURNAMENT_NOT_FOUND');
      }
      if (!JOINABLE_STATES.includes(tournament.state)) {
        throw new EntryCodeError(
          409,
          `Cannot join while tournament is in state '${tournament.state}'; expected ${JOINABLE_STATES.join(' or ')}`,
          'TOURNAMENT_NOT_OPEN'
        );
      }

      const codeRes = await client.query<{ id: string; max_uses: number; uses: number; expires_at: Date | null }>(
        `SELECT id, max_uses, uses, expires_at
         FROM tournament_entry_codes
         WHERE tournament_id = $1 AND code_hash = $2
         FOR UPDATE`,
        [tournamentId, codeHash]
      );
      const entryCode = codeRes.rows[0];
      if (!entryCode) {
        throw new EntryCodeError(403, 'Entry code is not valid for this tournament', 'ENTRY_CODE_INVALID');
      }
      if (entryCode.expires_at && entryCode.expires_at.getTime() <= Date.now()) {
        throw new EntryCodeError(403, 'Entry code has expired', 'ENTRY_CODE_EXPIRED');
      }
      if (entryCode.uses >= entryCode.max_uses) {
        throw new EntryCodeError(403, 'Entry code has been fully redeemed', 'ENTRY_CODE_EXHAUSTED');
      }

      const teamRes = await client.query<{ id: string; captain_user_id: string }>(
        'SELECT id, captain_user_id FROM teams WHERE id = $1',
        [teamId]
      );
      const team = teamRes.rows[0];
      if (!team) {
        throw new EntryCodeError(404, `Team not found: ${teamId}`, 'TEAM_NOT_FOUND');
      }
      if (ctx.actor.role !== 'ADMIN' && team.captain_user_id !== ctx.actor.userId) {
        throw new EntryCodeError(
          403,
          'Only the team captain or an administrator can join a tournament',
          'NOT_TEAM_CAPTAIN'
        );
      }

      const existing = await client.query('SELECT id FROM tournament_entries WHERE tournament_id = $1 AND team_id = $2', [
        tournamentId,
        teamId,
      ]);
      if (existing.rows.length > 0) {
        throw new EntryCodeError(409, 'Team is already enrolled in this tournament', 'ALREADY_ENROLLED');
      }

      const countRes = await client.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM tournament_entries WHERE tournament_id = $1',
        [tournamentId]
      );
      if (parseInt(countRes.rows[0].count, 10) >= tournament.max_teams) {
        throw new EntryCodeError(
          409,
          `Tournament capacity of ${tournament.max_teams} team(s) is reached`,
          'CAPACITY_EXCEEDED'
        );
      }

      const redeemed = await client.query(
        'UPDATE tournament_entry_codes SET uses = uses + 1 WHERE id = $1 AND uses < max_uses',
        [entryCode.id]
      );
      if ((redeemed.rowCount ?? 0) === 0) {
        throw new EntryCodeError(403, 'Entry code has been fully redeemed', 'ENTRY_CODE_EXHAUSTED');
      }

      await client.query(
        `INSERT INTO tournament_admissions (tournament_id, team_id, admitted_by_user_id, admission_type)
         VALUES ($1, $2, $3, 'INVITE_CODE')`,
        [tournamentId, teamId, ctx.actor.userId]
      );
      const entryRes = await client.query<{ id: string; status: string }>(
        `INSERT INTO tournament_entries (tournament_id, team_id, status)
         VALUES ($1, $2, 'ELIGIBLE')
         RETURNING id, status`,
        [tournamentId, teamId]
      );
      const entry = entryRes.rows[0];

      await this.recordAudit(client, ctx, requestId, 'ENTRY_CODE_REDEEMED', tournamentId, {
        teamId,
        entryCodeId: entryCode.id,
        entryId: entry.id,
      });

      return { id: entry.id, tournamentId, teamId, status: entry.status };
    });
  }

  private async recordAudit(
    client: PoolClient,
    ctx: CommandContext,
    requestId: string,
    action: string,
    tournamentId: string,
    details: Record<string, unknown>
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_events (actor_user_id, action, resource_type, resource_id, request_id, details)
       VALUES ($1, $2, 'tournament', $3, $4, $5)`,
      [ctx.actor.userId, action, tournamentId, requestId, JSON.stringify(details)]
    );
  }
}
