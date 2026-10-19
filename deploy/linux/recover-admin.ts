import { openSync, closeSync, writeSync } from 'node:fs';
import { userInfo } from 'node:os';
import { Database } from '../../packages/server/src/persistence/db.js';
import { generateTemporaryPassword, hashPassword } from '../../packages/server/src/identity/crypto.js';

// Run locally: node --import tsx deploy/linux/recover-admin.ts <reason> <authorization-reference>
// Root is the explicit local recovery authority. Never accepts a password or target UUID via argv.
const [reason, authorizationReference, ...extra] = process.argv.slice(2);
if (process.getuid?.() !== 0 || !process.stdin.isTTY || !process.stdout.isTTY) {
  throw new Error('Recovery requires the authorized local root operator and an interactive terminal');
}
if (!reason?.trim() || !authorizationReference?.trim() || extra.length || reason.length > 1000 || authorizationReference.length > 200) {
  throw new Error('Supply a reason and authorization reference (not credentials)');
}
if (!process.env.PGHOST?.startsWith('/') || !process.env.PGDATABASE || !process.env.PGUSER || !process.env.PGPORT || process.env.PGPASSWORD) {
  throw new Error('Explicit Unix-socket PGHOST, PGPORT, PGDATABASE and PGUSER required; password environment forbidden');
}
const tty = openSync('/dev/tty', 'w');
const db = new Database();
try {
  const temporary = generateTemporaryPassword();
  const hash = await hashPassword(temporary);
  const admin = await db.withTransaction(async (client) => {
    await client.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
    const found = await client.query<{ id: string; username: string }>("SELECT id, username FROM users WHERE role = 'ADMIN' FOR UPDATE");
    if (found.rows.length !== 1) throw new Error('Recovery requires exactly one existing ADMIN; reconcile ownership explicitly');
    const row = found.rows[0];
    await client.query('UPDATE users SET password_hash = $1, password_change_required = TRUE, updated_at = clock_timestamp() WHERE id = $2', [hash, row.id]);
    await client.query('UPDATE sessions SET revoked_at = clock_timestamp() WHERE user_id = $1 AND revoked_at IS NULL', [row.id]);
    await client.query('UPDATE password_reset_tokens SET consumed_at = clock_timestamp() WHERE user_id = $1 AND consumed_at IS NULL', [row.id]);
    await client.query('UPDATE email_verification_tokens SET consumed_at = clock_timestamp() WHERE user_id = $1 AND consumed_at IS NULL', [row.id]);
    await client.query(`INSERT INTO audit_events(actor_user_id, action, resource_type, resource_id, details)
      VALUES ($1, 'LOCAL_ADMIN_RECOVERY', 'user', $1, $2)`, [row.id, JSON.stringify({ osUid: process.getuid?.(), osActor: userInfo().username, reason, authorizationReference })]);
    return row;
  });
  // Deliberate once-only private terminal delivery, never stdout, audit, or application logs.
  writeSync(tty, `ADMIN ${admin.username} (${admin.id}) recovered. Temporary password (shown once): ${temporary}\nChange it at next login.\n`);
} catch {
  process.exitCode = 1;
  writeSync(tty, 'Recovery failed; no credentials disclosed. Inspect database/operator configuration.\n');
} finally {
  closeSync(tty);
  await db.close();
}
