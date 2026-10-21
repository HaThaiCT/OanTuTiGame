import { openSync, closeSync, fstatSync, readFileSync, constants } from 'node:fs';
import { loadOnlineConfig } from '../../packages/server/src/identity/online-config.js';
import { Database } from '../../packages/server/src/persistence/db.js';
import { EXPECTED_SCHEMA_VERSION } from '../../packages/server/src/persistence/schema-version.js';

function loadDatabasePassword(): void {
  const path = process.env.PGPASSWORD_FILE;
  if (!path) throw new Error('PGPASSWORD_FILE is required');
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 65536) throw new Error();
    const password = readFileSync(fd, 'utf8').replace(/\r?\n$/, '');
    if (!password || /[\r\n\0]/.test(password)) throw new Error();
    process.env.PGPASSWORD = password;
  } catch {
    throw new Error('Invalid PGPASSWORD_FILE');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

async function main(): Promise<void> {
  const config = loadOnlineConfig();
  if (!config) throw new Error('OANTUTI_AUTH_PROFILE must be exactly ONLINE for this preflight');
  loadDatabasePassword();
  const database = new Database();
  try {
    const result = await database.query<{ version: number | null }>('SELECT max(version)::integer AS version FROM schema_migrations');
    const version = result.rows[0]?.version ?? 0;
    if (version !== EXPECTED_SCHEMA_VERSION) throw new Error(`Schema version ${version} does not match expected ${EXPECTED_SCHEMA_VERSION}`);
  } finally {
    await database.close();
  }
  process.stdout.write(JSON.stringify({ ok: true, profile: 'ONLINE', publicOrigin: config.publicBaseUrl, schemaVersion: EXPECTED_SCHEMA_VERSION, trustedProxyCount: config.trustedProxies.length, smtpConfigured: true, mailTransportContacted: false }, null, 2) + '\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
