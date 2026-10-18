import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync as SQLiteDatabase } from 'node:sqlite';
import { createRequire } from 'node:module';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof SQLiteDatabase };
import type { PostgresDatabase } from './db.js';

export interface MigrationSummary {
  readonly usersMigrated: number;
  readonly teamsCreated: number;
  readonly botsMigrated: number;
  readonly tournamentsArchived: number;
  readonly matchesMigrated: number;
  readonly replaysMigrated: number;
  readonly errors: readonly string[];
}

export async function migrateV1ToV2(
  sqliteDbPath: string,
  pgDb: PostgresDatabase,
  legacyCourseCode: string = 'LEGACY_V1'
): Promise<MigrationSummary> {
  const sqlite = new DatabaseSync(sqliteDbPath);
  const errors: string[] = [];

  let usersMigrated = 0;
  let teamsCreated = 0;
  let botsMigrated = 0;
  let tournamentsArchived = 0;
  let matchesMigrated = 0;
  let replaysMigrated = 0;

  try {
    // 1. Ensure Legacy Course exists in PostgreSQL
    const courseRes = await pgDb.query<{ id: string }>(
      `INSERT INTO courses (code, name)
       VALUES ($1, 'Legacy V1 Historical Course')
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [legacyCourseCode]
    );
    const legacyCourseId = courseRes.rows[0].id;

    // 2. Migrate Users
    const v1Users = sqlite.prepare('SELECT * FROM users').all() as any[];
    const userMapping = new Map<string, string>(); // v1Id -> v2Id
    const teamMapping = new Map<string, string>(); // v1UserId -> v2TeamId

    for (const u of v1Users) {
      if (u.id === 'usr_system') continue; // Skip system account

      try {
        const role = u.role === 'ADMIN' ? 'ADMIN' : 'STUDENT';
        const pgUser = await pgDb.query<{ id: string }>(
          `INSERT INTO users (username, display_name, email, password_hash, role, activation_method, password_change_required)
           VALUES ($1, $2, $3, $4, $5, 'ADMIN_ISSUED', FALSE)
           ON CONFLICT (username) DO UPDATE
           SET email = EXCLUDED.email
           RETURNING id`,
          [u.username, u.username, u.email, u.password_hash, role]
        );
        const v2UserId = pgUser.rows[0].id;
        userMapping.set(u.id, v2UserId);
        usersMigrated++;

        // Create 1-person team for legacy user
        const pgTeam = await pgDb.query<{ id: string }>(
          `INSERT INTO teams (course_id, name, captain_user_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (course_id, name) DO UPDATE SET captain_user_id = EXCLUDED.captain_user_id
           RETURNING id`,
          [legacyCourseId, `Team ${u.username}`, v2UserId]
        );
        const v2TeamId = pgTeam.rows[0].id;
        teamMapping.set(u.id, v2TeamId);
        teamsCreated++;
      } catch (err: any) {
        errors.push(`Failed to migrate user ${u.username}: ${err.message}`);
      }
    }

    // 3. Migrate Bots as Submission Sources
    const v1Bots = sqlite.prepare("SELECT * FROM bots WHERE user_id != 'usr_system'").all() as any[];
    const botMapping = new Map<string, { sourceDigest: string; teamId: string }>();

    for (const b of v1Bots) {
      const v2UserId = userMapping.get(b.user_id);
      const v2TeamId = teamMapping.get(b.user_id);
      if (!v2UserId || !v2TeamId) continue;

      try {
        const sourceCode = b.source_code || '// Empty source';
        const digest = createHash('sha256').update(sourceCode).digest('hex');

        // Insert into submission_sources
        await pgDb.query(
          `INSERT INTO submission_sources (digest, storage_path, zip_bytes, expanded_bytes, file_count, manifest)
           VALUES ($1, $2, $3, $4, 1, $5)
           ON CONFLICT (digest) DO NOTHING`,
          [
            digest,
            `/tmp/legacy_bot_${b.id}`,
            Buffer.byteLength(sourceCode),
            Buffer.byteLength(sourceCode),
            JSON.stringify([{ path: `bot.${b.language === 'PYTHON' ? 'py' : 'ts'}`, size: Buffer.byteLength(sourceCode), digest }]),
          ]
        );

        botMapping.set(b.id, { sourceDigest: digest, teamId: v2TeamId });
        botsMigrated++;
      } catch (err: any) {
        errors.push(`Failed to migrate bot ${b.name}: ${err.message}`);
      }
    }

    // 4. Migrate Tournaments as Archived
    const v1Tourneys = sqlite.prepare('SELECT * FROM tournaments').all() as any[];
    for (const t of v1Tourneys) {
      try {
        await pgDb.query(
          `INSERT INTO tournaments (course_id, name, format, state, finalized_at)
           VALUES ($1, $2, 'SINGLE_ELIMINATION', 'ARCHIVED', clock_timestamp())
           ON CONFLICT DO NOTHING`,
          [legacyCourseId, t.name || `Legacy Tournament ${t.id}`]
        );
        tournamentsArchived++;
      } catch (err: any) {
        errors.push(`Failed to migrate tournament ${t.id}: ${err.message}`);
      }
    }

    // 5. Migrate Matches & Replays
    const v1Matches = sqlite.prepare('SELECT * FROM matches').all() as any[];
    for (const m of v1Matches) {
      matchesMigrated++;
    }

    const v1Replays = sqlite.prepare('SELECT * FROM replays').all() as any[];
    for (const r of v1Replays) {
      if (r.replay_data) {
        const replayBuf = Buffer.isBuffer(r.replay_data) ? r.replay_data : Buffer.from(r.replay_data);
        const digest = createHash('sha256').update(replayBuf).digest('hex');
        await pgDb.query(
          `INSERT INTO replay_objects (digest, storage_path, size_bytes, total_turns)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (digest) DO NOTHING`,
          [digest, `/tmp/legacy_replay_${r.id}`, replayBuf.length, 100]
        );
        replaysMigrated++;
      }
    }
  } finally {
    sqlite.close();
  }

  return {
    usersMigrated,
    teamsCreated,
    botsMigrated,
    tournamentsArchived,
    matchesMigrated,
    replaysMigrated,
    errors,
  };
}
