#!/usr/bin/env node
/**
 * Operator bootstrap for the first ADMIN of a v2 deployment.
 *
 * A freshly migrated database has no account and no route may create one (LAN_OFFLINE issues every
 * account from an organizer). This is the one controlled way in:
 *
 *  - every prerequisite is checked before the first write, so a missing capacity, a closed terminal
 *    or a wrong database cannot leave an ADMIN behind whose password nobody received;
 *  - the account, the account capacity and the audit entry commit in one transaction;
 *  - it refuses a database that already has an ADMIN, and refuses a database name the operator has
 *    not confirmed explicitly;
 *  - it never accepts a password on the command line. Over a Unix socket it runs as the operator;
 *    over TCP it requires `PGPASSWORD_FILE` (a file, never an environment value).
 *
 * Usage:
 *   OANTUTI_BOOTSTRAP_CONFIRM=<exact database name> \
 *   OANTUTI_ACCOUNT_CAPACITY=<positive integer> \
 *     node --import tsx deploy/linux/bootstrap-admin.mts <username>
 *
 * Environment: standard PGHOST/PGPORT/PGUSER/PGDATABASE. PGPASSWORD is refused; use PGPASSWORD_FILE.
 */
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import type pg from 'pg';
import { PostgresDatabase } from '../../packages/server/src/persistence/db.js';
import { hashPassword, validPassword } from '../../packages/server/src/identity/crypto.js';

const [username, ...extra] = process.argv.slice(2);
if (!username || username.length < 2 || username.length > 50 || extra.length || !/^[A-Za-z0-9._-]+$/.test(username)) {
  throw new Error('Usage: bootstrap-admin.mts <username> (2–50 characters, letters/digits/._-)');
}

// The credential is printed to the terminal that requested it; do not start if nobody is there.
const tty = openSync('/dev/tty', 'w');
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  closeSync(tty);
  throw new Error('Interactive terminal required');
}

if (!process.env.PGHOST || !process.env.PGDATABASE || !process.env.PGUSER || !process.env.PGPORT) {
  throw new Error('Explicit PGHOST, PGPORT, PGDATABASE and PGUSER required');
}
if (process.env.PGPASSWORD) {
  throw new Error('Password environment is forbidden; use PGPASSWORD_FILE');
}
if (!process.env.PGHOST.startsWith('/')) {
  const secretFile = process.env.PGPASSWORD_FILE;
  if (!secretFile) throw new Error('TCP connections require PGPASSWORD_FILE');
  const secret = readFileSync(secretFile, 'utf8').trim();
  if (!secret) throw new Error('PGPASSWORD_FILE must not be empty');
  process.env.PGPASSWORD = secret;
}

const confirmation = process.env.OANTUTI_BOOTSTRAP_CONFIRM;
if (confirmation !== process.env.PGDATABASE) {
  throw new Error(`Set OANTUTI_BOOTSTRAP_CONFIRM=${process.env.PGDATABASE} to confirm this exact database`);
}

/** A one-time credential the operator hands over privately; never logged by the service. */
function temporaryPassword(): string {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let value = '';
  for (let index = 0; index < 24; index++) value += alphabet[randomInt(alphabet.length)];
  // Guarantee the policy classes without weakening the random part.
  return `${value}Aa9!`;
}

const configuredCapacity = Number(process.env.OANTUTI_ACCOUNT_CAPACITY ?? '');

const db = new PostgresDatabase();
try {
  // Validate the capacity *before* anything is written: LAN provisioning refuses to run without it,
  // so an ADMIN created without it could not issue a single account.
  const capacityRow = await db.query<{ value: { limit?: unknown } }>(
    "SELECT value FROM deployment_settings WHERE key = 'accountCapacity'"
  );
  const existingLimit = capacityRow.rows[0]?.value?.limit;
  if (capacityRow.rows.length > 0 && (typeof existingLimit !== 'number' || !Number.isSafeInteger(existingLimit) || existingLimit < 1)) {
    throw new Error('Existing accountCapacity must contain a positive integer limit');
  }
  if (capacityRow.rows.length === 0 && (!Number.isSafeInteger(configuredCapacity) || configuredCapacity < 1)) {
    throw new Error('Set OANTUTI_ACCOUNT_CAPACITY to the positive account limit for this deployment');
  }
  const password = temporaryPassword();
  if (!validPassword(password)) throw new Error('Generated credential failed the password policy');
  const hashed = await hashPassword(password);

  const admin = await db.withTransaction(async (client: pg.PoolClient) => {
    await client.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
    const existing = await client.query<{ id: string }>("SELECT id FROM users WHERE role = 'ADMIN'");
    if (existing.rows.length > 0) {
      throw new Error('Singleton ADMIN account already bootstrapped');
    }
    const inserted = await client.query<{ id: string; username: string }>(
      `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required, temporary_password_expires_at)
       VALUES ($1, 'Administrator', $2, 'ADMIN', 'ADMIN_ISSUED', TRUE, clock_timestamp() + interval '24 hours')
       RETURNING id, username`,
      [username.trim(), hashed]
    );
    const row = inserted.rows[0];
    // Re-check under the same transaction: the pre-flight read is advisory, this one is authoritative.
    const capacity = await client.query<{ value: { limit?: unknown } }>(
      "SELECT value FROM deployment_settings WHERE key = 'accountCapacity' FOR UPDATE"
    );
    const existingLimit = capacity.rows[0]?.value?.limit;
    if (capacity.rows.length === 0) {
      await client.query(
        `INSERT INTO deployment_settings (key, value) VALUES ('accountCapacity', $1::jsonb)`,
        [JSON.stringify({ limit: configuredCapacity })]
      );
    } else if (typeof existingLimit !== 'number' || !Number.isSafeInteger(existingLimit) || existingLimit < 1) {
      throw new Error('Existing accountCapacity must contain a positive integer limit');
    }
    await client.query(
      `INSERT INTO audit_events (actor_user_id, action, resource_type, resource_id, details)
       VALUES ($1, 'ADMIN_BOOTSTRAPPED', 'user', $2, $3)`,
      [row.id, row.id, JSON.stringify({ username: row.username, osUser: process.env.USER ?? 'unknown', operatorConfirmation: true })]
    );
    return row;
  });

  try {
    writeSync(tty, `\nADMIN ${admin.username} created (${admin.id}).\nTemporary password (printed once): ${password}\nHand it over privately; first login forces a change.\n\n`);
  } finally { closeSync(tty); }
  process.stdout.write(`ADMIN ${admin.username} created\n`);
} catch (error) {
  closeSync(tty);
  throw error;
} finally {
  await db.close();
}
