import { beforeAll } from 'vitest';
import { PostgresDatabase, resolveDbConfig } from '../../src/persistence/db.js';

/**
 * Test-only reconciliation for the singleton-ADMIN contract (`users_singleton_admin`, migration 022).
 *
 * Suites share one isolated database, and the ADMIN uniqueness the migration enforces is
 * per-database rather than per-file: a fixture administrator left behind by an earlier file makes
 * the next file's own admin insert fail with a unique violation. Vitest runs files sequentially, so
 * retiring the previous file's ADMIN before each file restores the invariant without deleting
 * anything — the stale row keeps its data and simply stops occupying the singleton slot, exactly as
 * an operator would reconcile a duplicate before applying migration 022.
 *
 * Safety: this only ever demotes rows when the connected database carries an isolated test name
 * (`arena_*test*`), the same rule `deploy/linux/test-isolated.mts` enforces. Any other database —
 * including the development/demo one — is left untouched, and a plain `npm test` without PostgreSQL
 * simply warns instead of failing suites that do not need a database.
 */
beforeAll(async () => {
  const config = resolveDbConfig();
  const database = config.database;
  if (!/^arena_[a-z0-9_]*test[a-z0-9_]*$/.test(database)) {
    console.warn(`[singleton-admin] skipped: ${database} is not an isolated arena_*test* database`);
    return;
  }
  const db = new PostgresDatabase(config);
  try {
    const connected = await db.query<{ name: string }>('SELECT current_database() AS name');
    if (connected.rows[0]?.name !== database) {
      console.warn('[singleton-admin] skipped: connected database does not match PGDATABASE');
      return;
    }
    const retired = await db.query<{ id: string; username: string }>(
      "UPDATE users SET role = 'STUDENT' WHERE role = 'ADMIN' RETURNING id, username"
    );
    if (retired.rowCount) {
      console.info(
        `[singleton-admin] retired ${retired.rowCount} leftover ADMIN fixture(s) from earlier files: ` +
          retired.rows.map((row) => row.username).join(', ')
      );
    }
  } catch (error) {
    console.warn(`[singleton-admin] skipped: ${(error as Error).message}`);
  } finally {
    await db.close();
  }
});
