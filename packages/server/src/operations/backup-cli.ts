#!/usr/bin/env node
/** Invoke with node --import tsx packages/server/src/operations/backup-cli.ts. No development defaults. */
import { PostgresDatabase, type DbConfig } from '../persistence/db.js';
import { activateRestoredGeneration, produceCheckpoint, verifyCheckpoint, publishCheckpoint } from './backup-checkpoint.js';

const usage = `Commands:
  produce --root ABS --sources ABS --replays ABS --compiled ABS --completions ABS --host HOST --port PORT --database DB --user ROLE
  verify --root ABS --digest SHA256
  publish --root ABS --digest SHA256 --host HOST --port PORT --database DB --user oantuti_backup_verifier
  activate-restore --root ABS --digest SHA256 --sources ABS --replays ABS --compiled ABS --completions ABS --isolated yes --host HOST --port PORT --database DB --user ROLE
Roots must already exist, be private/operator-owned, and must not contain symlinks.
The expected manifest digest must arrive over an independently authenticated channel.
Use PGPASSFILE for credentials. produce requires pg_dump in PATH and writes a new empty root.
Copy the checkpoint to separately administered backup storage, then verify/publish THERE.
Publishing verifies destination bytes; this command does not claim or provision offhost placement.
Restore database.dump with pg_restore --no-owner --no-acl into a NEW isolated database,
restore each object root, then activate-restore once before API/workers start. Set their generation
from backup_identity; restart all workers with new grants. Use --completions for ONLY the immutable
native completion capsule directory, never the transient attempt spool. Preserved pending capsules
retain original fencing identity and must match the same executable profile. This is not PITR:
restoreLsn binds the WAL position observed at capture, not a claim that WAL was archived.
`;
async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--help') { process.stdout.write(usage); return; }
  if (!['produce', 'verify', 'publish', 'activate-restore'].includes(command ?? '')) throw new Error(usage);
  const options: Record<string, string> = {};
  const allowed = ['root', 'sources', 'replays', 'compiled', 'completions', 'digest', 'host', 'port', 'database', 'user', 'isolated'];
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    const value = args[i + 1];
    if (!args[i]?.startsWith('--') || !allowed.includes(key) || !value || value.startsWith('--') || options[key]) throw new Error('Unknown, duplicate or missing option');
    options[key] = value;
  }
  if (!options.root) throw new Error('--root is required');
  if (command === 'verify') {
    const report = verifyCheckpoint(options.root, options.digest ?? '');
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  if (!options.host || !options.port || !options.database || !options.user || !/^\d+$/.test(options.port) || Number(options.port) < 1 || Number(options.port) > 65535) throw new Error('Explicit --host --port --database --user required');
  const config: DbConfig = { host: options.host, port: Number(options.port), database: options.database, user: options.user, max: 2 };
  const db = new PostgresDatabase(config);
  try {
    if (command === 'produce') {
      if (!options.sources || !options.replays || !options.compiled || !options.completions) throw new Error('All --sources --replays --compiled --completions object roots required');
      process.stdout.write(`${await produceCheckpoint(db, config, options.root, { sources: options.sources, replays: options.replays, compiled: options.compiled, completions: options.completions })}\n`);
    } else {
      const report = verifyCheckpoint(options.root, options.digest ?? '');
      if (command === 'publish') {
        await publishCheckpoint(db, report);
        process.stdout.write(`${JSON.stringify(report)}\n`);
      } else {
        if (options.isolated !== 'yes') throw new Error('--isolated yes is required; API/workers must be stopped');
        if (!options.sources || !options.replays || !options.compiled || !options.completions) throw new Error('All restored object roots are required');
        const generation = await db.withTransaction((client) => activateRestoredGeneration(client, report, { sources: options.sources, replays: options.replays, compiled: options.compiled, completions: options.completions }));
        process.stdout.write(`${JSON.stringify({ generation, activated: true })}\n`);
      }
    }
  } finally { await db.close(); }
}
main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
