import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { PostgresDatabase, resolveDbConfig } from '../../packages/server/src/persistence/db.js';

const config = resolveDbConfig();
const database = process.env.PGDATABASE;
if (!database || !/^arena_[a-z0-9_]*test[a-z0-9_]*$/.test(database) || database !== config.database) {
  throw new Error('Explicit isolated PGDATABASE matching arena_*test* is required; demo/production databases are forbidden');
}
const db = new PostgresDatabase(config);
try {
  const result = await db.query<{ name: string }>('SELECT current_database() AS name');
  if (result.rows[0]?.name !== database) throw new Error('Connected database does not match isolated test database');
} finally { await db.close(); }
const child = spawn(resolve('node_modules/.bin/vitest'), ['run', ...process.argv.slice(2)], {
  cwd: process.cwd(), env: { ...process.env }, stdio: 'inherit',
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
