import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Database } from '../src/persistence/db.js';
import { MatchExecutionService } from '../src/tournaments/execution-service.js';

/**
 * The executor is only allowed to touch private helpers through this narrow shape; the deps are
 * irrelevant for candidate resolution, so they stay undefined casts.
 */
interface CandidateResolver {
  loadCandidate(tournamentId: string, teamId: string, side: string): Promise<{ id: string; source_digest: string }>;
}

describe('S10 official games freeze their artifact at lock time', () => {
  let db: Database;
  let service: MatchExecutionService;
  const ids = {
    userId: randomUUID(),
    courseId: randomUUID(),
    teamId: randomUUID(),
    tournamentId: randomUUID(),
  };
  const olderDigest = 'a'.repeat(64);
  const newerDigest = 'b'.repeat(64);

  beforeAll(async () => {
    db = new Database();
    service = new MatchExecutionService(
      db,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      { spoolDir: '/tmp/oantuti-frozen-candidate-test' }
    );

    await db.query(
      `INSERT INTO users (id, username, display_name, password_hash, role, activation_method)
       VALUES ($1, $2, 'Frozen Test', 'scrypt$deadbeef', 'STUDENT', 'ADMIN_ISSUED')`,
      [ids.userId, `frozen_${ids.userId.slice(0, 8)}`]
    );
    await db.query(`INSERT INTO courses (id, code, name) VALUES ($1, $2, 'Frozen Test Course')`, [
      ids.courseId,
      `FROZEN_${ids.courseId.slice(0, 8)}`,
    ]);
    await db.query(`INSERT INTO teams (id, course_id, name, captain_user_id) VALUES ($1, $2, 'Frozen Team', $3)`, [
      ids.teamId,
      ids.courseId,
      ids.userId,
    ]);
    await db.query(
      `INSERT INTO tournaments (id, course_id, name, format, state, max_teams)
       VALUES ($1, $2, 'Frozen Test Cup', 'ROUND_ROBIN', 'RUNNING', 4)`,
      [ids.tournamentId, ids.courseId]
    );
    await db.query(
      `INSERT INTO submission_sources (digest, storage_path, zip_bytes, expanded_bytes, file_count, manifest)
       VALUES ($1, $2, 0, 0, 0, '{}'::jsonb), ($3, $4, 0, 0, 0, '{}'::jsonb)`,
      [olderDigest, `/tmp/frozen-candidate/${olderDigest}.zip`, newerDigest, `/tmp/frozen-candidate/${newerDigest}.zip`]
    );
    await db.query(
      `INSERT INTO submissions (tournament_id, team_id, submitted_by_user_id, receipt_ordinal, source_digest, language, entrypoint, status)
       VALUES ($1, $2, $3, 1, $4, 'TYPESCRIPT', 'main.ts', 'READY'),
              ($1, $2, $3, 2, $5, 'TYPESCRIPT', 'main.ts', 'READY')`,
      [ids.tournamentId, ids.teamId, ids.userId, olderDigest, newerDigest]
    );
  });

  afterAll(async () => {
    await db.query('DELETE FROM tournament_entries WHERE tournament_id = $1', [ids.tournamentId]);
    await db.query('DELETE FROM submissions WHERE tournament_id = $1', [ids.tournamentId]);
    await db.query('DELETE FROM submission_sources WHERE digest = ANY($1::text[])', [[olderDigest, newerDigest]]);
    await db.query('DELETE FROM tournaments WHERE id = $1', [ids.tournamentId]);
    await db.query('DELETE FROM teams WHERE id = $1', [ids.teamId]);
    await db.query('DELETE FROM courses WHERE id = $1', [ids.courseId]);
    await db.query('DELETE FROM users WHERE id = $1', [ids.userId]);
    await db.close();
  });

  it('plays the frozen submission even when a newer READY receipt exists', async () => {
    await db.query(
      `INSERT INTO tournament_entries (tournament_id, team_id, status, seed_ordinal, frozen_submission_id)
       SELECT $1, $2, 'ELIGIBLE', 1, s.id FROM submissions s
       WHERE s.tournament_id = $1 AND s.team_id = $2 AND s.source_digest = $3`,
      [ids.tournamentId, ids.teamId, olderDigest]
    );

    const resolver = service as unknown as CandidateResolver;
    const frozen = await resolver.loadCandidate(ids.tournamentId, ids.teamId, 'white');
    expect(frozen.source_digest).toBe(olderDigest);

    // Without a freeze the latest READY receipt stays the candidate (pre-freeze dev entries).
    await db.query('UPDATE tournament_entries SET frozen_submission_id = NULL WHERE tournament_id = $1', [
      ids.tournamentId,
    ]);
    const latest = await resolver.loadCandidate(ids.tournamentId, ids.teamId, 'white');
    expect(latest.source_digest).toBe(newerDigest);
  });
});
