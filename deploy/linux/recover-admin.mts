import { closeSync, constants, fstatSync, openSync, readSync, writeSync } from 'node:fs';
import { userInfo } from 'node:os';
import { Database } from '../../packages/server/src/persistence/db.js';
import { IdentityService } from '../../packages/server/src/identity/service.js';
import { generateTemporaryPassword, hashPassword } from '../../packages/server/src/identity/crypto.js';
import { loadOnlineConfig, resolveAuthProfile } from '../../packages/server/src/identity/online-config.js';

// Run locally: node --import tsx deploy/linux/recover-admin.mts <reason> <authorization-reference> [authorized-new-email]
// Root is the explicit local recovery authority. Never accepts a password or target UUID via argv.
const [reason, authorizationReference, newEmail, ...extra] = process.argv.slice(2);
if (process.getuid?.() !== 0 || !process.stdin.isTTY || !process.stdout.isTTY) {
  throw new Error('Recovery requires the authorized local root operator and an interactive terminal');
}
if (!reason?.trim() || !authorizationReference?.trim() || extra.length || reason.length > 1000 || authorizationReference.length > 200) {
  throw new Error('Supply a reason, authorization reference and optional authorized email (not credentials)');
}
if (!process.env.PGHOST || !process.env.PGDATABASE || !process.env.PGUSER || !process.env.PGPORT || process.env.PGPASSWORD) {
  throw new Error('Explicit PGHOST, PGPORT, PGDATABASE and PGUSER required; PGPASSWORD forbidden');
}
if (!process.env.PGHOST.startsWith('/')) {
  const secretFile = process.env.PGPASSWORD_FILE;
  if (!secretFile) throw new Error('TCP connections require PGPASSWORD_FILE');
  const fd = openSync(secretFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > 4096) throw new Error('Unsafe PGPASSWORD_FILE');
    const buffer = Buffer.alloc(stat.size);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    let secret: string;
    try { secret = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes)); } catch { throw new Error('Invalid PGPASSWORD_FILE encoding'); }
    if (bytes !== stat.size || !secret || /[\r\n\0]/.test(secret)) throw new Error('Invalid PGPASSWORD_FILE contents');
    process.env.PGPASSWORD = secret;
  } finally { closeSync(fd); }
}
const authProfile = resolveAuthProfile();
const onlineConfig = authProfile === 'ONLINE' ? loadOnlineConfig() : undefined;
if (authProfile === 'ONLINE' && !onlineConfig) throw new Error('ONLINE recovery requires validated ONLINE configuration');
if (authProfile === 'ONLINE' && !newEmail) throw new Error('ONLINE recovery requires an explicitly authorized replacement email');
if (process.env.OANTUTI_RECOVERY_CONFIRM !== process.env.PGDATABASE) throw new Error(`Set OANTUTI_RECOVERY_CONFIRM=${process.env.PGDATABASE} to confirm this exact database`);
const tty = openSync('/dev/tty', 'w');
const db = new Database();
try {
  if (authProfile === 'ONLINE') {
    const config = onlineConfig!;
    const service = new IdentityService(db, 'ONLINE', { mail: { keyring: config.keyring, publicBaseUrl: config.publicBaseUrl, from: config.from, replyTo: config.replyTo } });
    const admin = await service.recoverOnlineAdmin(newEmail!, reason, authorizationReference);
    writeSync(tty, `ONLINE ADMIN ${admin.username} (${admin.id}) recovered; email verification is pending. Temporary password (shown once): ${admin.temporaryPassword}\nChange it at next login.\n`);
  } else {
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
      await client.query(`INSERT INTO audit_events(actor_user_id, action, resource_type, resource_id, details) VALUES ($1, 'LOCAL_ADMIN_RECOVERY', 'user', $1, $2)`, [row.id, JSON.stringify({ osUid: process.getuid?.(), osActor: userInfo().username, reason, authorizationReference })]);
      return row;
    });
    writeSync(tty, `ADMIN ${admin.username} (${admin.id}) recovered. Temporary password (shown once): ${temporary}\nChange it at next login.\n`);
  }
} catch {
  process.exitCode = 1;
  writeSync(tty, 'Recovery failed; no credentials disclosed. Inspect database/operator configuration.\n');
} finally {
  closeSync(tty);
  await db.close();
}
