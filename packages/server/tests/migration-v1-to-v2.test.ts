import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DatabaseSync as SQLiteDatabase } from 'node:sqlite';
import { createRequire } from 'node:module';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof SQLiteDatabase };
import { rmSync } from 'node:fs';
import { PostgresDatabase } from '../src/persistence/db.js';
import { migrateV1ToV2 } from '../src/persistence/migrate-v1-to-v2.js';

describe('S16: Linux Packaging, Backup/Restore Drill, Migration (T11)', () => {
  let pgDb: PostgresDatabase;
  const tempSqlitePath = '/tmp/test_v1_legacy.db';

  beforeAll(async () => {
    pgDb = new PostgresDatabase();
    rmSync(tempSqlitePath, { force: true });

    // Setup dummy v1 SQLite database
    const sqlite = new DatabaseSync(tempSqlitePath);
    sqlite.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'USER'
      );
      CREATE TABLE bots (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        language TEXT NOT NULL,
        source_code TEXT NOT NULL
      );
      CREATE TABLE tournaments (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );
      CREATE TABLE matches (
        id TEXT PRIMARY KEY
      );
      CREATE TABLE replays (
        id TEXT PRIMARY KEY,
        replay_data BLOB
      );

      INSERT INTO users VALUES ('usr_1', 'legacy_player', 'legacy@uni.edu', 'hash_legacy', 'USER');
      INSERT INTO bots VALUES ('bot_1', 'usr_1', 'OldBot', 'PYTHON', '# Legacy bot source code');
      INSERT INTO tournaments VALUES ('tourney_1', 'Fall Tournament 2024');
      INSERT INTO matches VALUES ('m_1');
      INSERT INTO replays VALUES ('rep_1', X'4F414E5455544931');
    `);
    sqlite.close();
  });

  afterAll(async () => {
    await pgDb.close();
    rmSync(tempSqlitePath, { force: true });
  });

  it('migrates v1 users, creates single-member teams, and archives completed tournaments', async () => {
    const summary = await migrateV1ToV2(tempSqlitePath, pgDb, 'LEGACY_V1_TEST');

    expect(summary.usersMigrated).toBe(1);
    expect(summary.teamsCreated).toBe(1);
    expect(summary.botsMigrated).toBe(1);
    expect(summary.tournamentsArchived).toBe(1);
    expect(summary.replaysMigrated).toBe(1);
    expect(summary.errors.length).toBe(0);

    // Verify v2 user in PostgreSQL
    const uRes = await pgDb.query<{ username: string; role: string }>(
      "SELECT username, role FROM users WHERE username = 'legacy_player'"
    );
    expect(uRes.rows[0].username).toBe('legacy_player');
    expect(uRes.rows[0].role).toBe('STUDENT');

    // Verify archived tournament in PostgreSQL
    const tRes = await pgDb.query<{ name: string; state: string }>(
      "SELECT name, state FROM tournaments WHERE name = 'Fall Tournament 2024'"
    );
    expect(tRes.rows[0].state).toBe('ARCHIVED');
  });
});
