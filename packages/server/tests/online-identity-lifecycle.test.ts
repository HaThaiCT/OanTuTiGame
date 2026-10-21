import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Database } from '../src/persistence/db.js';
import { IdentityService } from '../src/identity/service.js';
import { generateToken, hashPassword, hashToken } from '../src/identity/crypto.js';

const run = `online_lifecycle_${Date.now().toString(36)}`;
const password = 'OnlineLifecyclePassword2026!';

describe('ONLINE current-email verification and recovery boundaries', () => {
  let db: Database;
  const ids: string[] = [];
  beforeAll(() => { db = new Database(); });
  afterAll(async () => {
    for (const id of ids) {
      await db.query('DELETE FROM sessions WHERE user_id=$1', [id]);
      await db.query('DELETE FROM password_reset_tokens WHERE user_id=$1', [id]);
      await db.query('DELETE FROM email_verification_tokens WHERE user_id=$1', [id]);
      await db.query('DELETE FROM users WHERE id=$1', [id]);
    }
    await db.close();
  });

  async function user(suffix: string, activation = 'LOCAL_BOOTSTRAP') {
    const username = `${run}_${suffix}`;
    const result = await db.query<{ id: string }>(`INSERT INTO users(username,display_name,email,password_hash,role,activation_method,password_change_required)
      VALUES ($1,$1,$2,$3,'STUDENT',$4,false) RETURNING id`, [username, `${username}@example.test`, await hashPassword(password), activation]);
    ids.push(result.rows[0].id);
    return { id: result.rows[0].id, username };
  }

  it('does not treat a LAN bootstrap password as verified ONLINE identity', async () => {
    const target = await user('lan');
    const identity = new IdentityService(db, 'ONLINE');
    await expect(identity.login(target.username, password)).rejects.toMatchObject({ code: 'EMAIL_VERIFICATION_REQUIRED' });
    const sessions = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM sessions WHERE user_id=$1', [target.id]);
    expect(sessions.rows[0].count).toBe('0');
  });

  it('cannot reuse a historical consumed token to activate the current email', async () => {
    const target = await user('history', 'SELF_REGISTER');
    const token = generateToken();
    await db.query(`INSERT INTO email_verification_tokens(user_id,token_hash,target_email,purpose,expires_at,consumed_at)
      VALUES ($1,$2,$3,'EMAIL_VERIFICATION',clock_timestamp()+interval '1 hour',clock_timestamp())`, [target.id, token.hash, `historical_${run}@example.test`]);
    await db.query('UPDATE users SET email=$2 WHERE id=$1', [target.id, `changed_${run}@example.test`]);
    await expect(new IdentityService(db, 'ONLINE').login(target.username, password)).rejects.toMatchObject({ code: 'EMAIL_VERIFICATION_REQUIRED' });
  });

  it('revokes sibling reset tokens when one reset succeeds without activating pending email', async () => {
    const target = await user('siblings', 'SELF_REGISTER');
    const first = generateToken();
    const sibling = generateToken();
    await db.query(`INSERT INTO password_reset_tokens(user_id,token_hash,target_email,expires_at)
      VALUES ($1,$2,$4,clock_timestamp()+interval '20 minutes'),($1,$3,$4,clock_timestamp()+interval '20 minutes')`, [target.id, first.hash, sibling.hash, `${target.username}@example.test`]);
    const identity = new IdentityService(db, 'ONLINE');
    await identity.resetPassword(first.raw, 'NewLifecyclePassword2026!');
    await expect(identity.resetPassword(sibling.raw, 'AnotherLifecyclePassword2026!')).rejects.toMatchObject({ code: 'PASSWORD_RESET_CONSUMED' });
    await expect(identity.login(target.username, 'NewLifecyclePassword2026!')).rejects.toMatchObject({ code: 'EMAIL_VERIFICATION_REQUIRED' });
  });
  it('expires a full identity rate window using PostgreSQL time despite a skewed application clock', async () => {
    const target = await user('rate_clock', 'SELF_REGISTER');
    const identity = new IdentityService(db, 'ONLINE', { mail: { keyring: { currentKeyId: 'test', keys: new Map([['test', Buffer.alloc(32, 7)]]) }, publicBaseUrl: 'https://arena.example', from: 'arena@example.test', replyTo: 'support@example.test' } });
    const accountKey = `account:${hashToken(`${target.username}@example.test`)}`;
    await db.query('DELETE FROM identity_rate_limits WHERE key=$1', [accountKey]);
    await db.query(`INSERT INTO identity_rate_limits(key,window_start,attempts) VALUES($1,clock_timestamp()-interval '61 minutes',3)`, [accountKey]);
    vi.setSystemTime(new Date(Date.now() - 2 * 60 * 60 * 1000));
    try {
      await identity.requestPasswordReset(`${target.username}@example.test`, '203.0.113.91');
      const current = await db.query<{ attempts: number; age: number }>(`SELECT attempts, extract(epoch FROM clock_timestamp()-window_start)::int AS age FROM identity_rate_limits WHERE key=$1`, [accountKey]);
      expect(current.rows[0].attempts).toBe(1);
      expect(current.rows[0].age).toBeLessThan(10);
    } finally {
      vi.useRealTimers();
    }
  });
  it('rejects a full rate window when the application clock is skewed forward', async () => {
    const target = await user('rate_skew', 'SELF_REGISTER');
    const identity = new IdentityService(db, 'ONLINE', { mail: { keyring: { currentKeyId: 'test', keys: new Map([['test', Buffer.alloc(32, 7)]]) }, publicBaseUrl: 'https://arena.example', from: 'arena@example.test', replyTo: 'support@example.test' } });
    const accountKey = `account:${hashToken(`${target.username}@example.test`)}`;
    await db.query('DELETE FROM identity_rate_limits WHERE key=$1', [accountKey]);
    await db.query('INSERT INTO identity_rate_limits(key,window_start,attempts) VALUES($1,clock_timestamp(),3)', [accountKey]);
    vi.setSystemTime(new Date(Date.now() + 2 * 60 * 60 * 1000));
    try {
      await expect(identity.requestPasswordReset(`${target.username}@example.test`, '203.0.113.95')).rejects.toMatchObject({ statusCode: 429 });
      const current = await db.query<{ attempts: number }>('SELECT attempts FROM identity_rate_limits WHERE key=$1', [accountKey]);
      expect(current.rows[0].attempts).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
  it('serializes concurrent attempts at the account limit boundary', async () => {
    const target = await user('rate_race', 'SELF_REGISTER');
    const identity = new IdentityService(db, 'ONLINE', { mail: { keyring: { currentKeyId: 'test', keys: new Map([['test', Buffer.alloc(32, 7)]]) }, publicBaseUrl: 'https://arena.example', from: 'arena@example.test', replyTo: 'support@example.test' } });
    const ip = `concurrent-test:${randomUUID()}`;
    const accountKey = `account:${hashToken(`${target.username}@example.test`)}`;
    const ipKey = `ip:${hashToken(ip)}`;
    await db.query('DELETE FROM identity_rate_limits WHERE key=ANY($1::text[])', [[accountKey, ipKey]]);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => identity.requestPasswordReset(`${target.username}@example.test`, ip)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(3);
    expect(results.filter((result) => result.status === 'rejected' && result.reason instanceof Error && 'statusCode' in result.reason && result.reason.statusCode === 429)).toHaveLength(5);
  });
  it('limits account reset requests to three per hour', async () => {
    const target = await user('rate_account', 'SELF_REGISTER');
    const identity = new IdentityService(db, 'ONLINE', { mail: { keyring: { currentKeyId: 'test', keys: new Map([['test', Buffer.alloc(32, 7)]]) }, publicBaseUrl: 'https://arena.example', from: 'arena@example.test', replyTo: 'support@example.test' } });
    for (let attempt = 0; attempt < 3; attempt++) await identity.requestPasswordReset(`${target.username}@example.test`, `account-limit-${target.id}`);
    await expect(identity.requestPasswordReset(`${target.username}@example.test`, `account-limit-${target.id}`)).rejects.toMatchObject({ statusCode: 429, retryAfterSeconds: expect.any(Number) });
  });

  it('limits reset requests by IP even for unknown accounts', async () => {
    const identity = new IdentityService(db, 'ONLINE', { mail: { keyring: { currentKeyId: 'test', keys: new Map([['test', Buffer.alloc(32, 7)]]) }, publicBaseUrl: 'https://arena.example', from: 'arena@example.test', replyTo: 'support@example.test' } });
    const ip = `test-ip:${randomUUID()}`;
    const ipKey = `ip:${hashToken(ip)}`;
    await db.query('DELETE FROM identity_rate_limits WHERE key=$1', [ipKey]);
    for (let attempt = 0; attempt < 20; attempt++) await identity.requestPasswordReset(`${randomUUID()}_${attempt}@example.test`, ip);
    await expect(identity.requestPasswordReset(`${randomUUID()}_final@example.test`, ip)).rejects.toMatchObject({ statusCode: 429, retryAfterSeconds: expect.any(Number) });
  });
  it('maintenance recovery preserves the singleton ADMIN identity and revokes sessions and outstanding tokens', async () => {
    const target = await user('maintenance_admin', 'SELF_REGISTER');
    const sessionToken = generateToken();
    const resetToken = generateToken();
    const verifyToken = generateToken();
    await db.query("UPDATE users SET role='ADMIN', email_verified_at=clock_timestamp() WHERE id=$1", [target.id]);
    await db.query(`INSERT INTO sessions(user_id,token_hash,scope,expires_at) VALUES($1,$2,'FULL',clock_timestamp()+interval '1 day')`, [target.id, sessionToken.hash]);
    await db.query(`INSERT INTO password_reset_tokens(user_id,token_hash,target_email,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`, [target.id, resetToken.hash, `${target.username}@example.test`]);
    await db.query(`INSERT INTO email_verification_tokens(user_id,token_hash,target_email,purpose,expires_at) VALUES($1,$2,$3,'EMAIL_VERIFICATION',clock_timestamp()+interval '1 hour')`, [target.id, verifyToken.hash, `${target.username}@example.test`]);
    const before = await db.query<{ username: string; email: string; email_verified_at: Date }>('SELECT username,email,email_verified_at FROM users WHERE id=$1', [target.id]);
    const replacement = await hashPassword('MaintenanceReplacementPassword2026!');
    await db.withTransaction(async (client) => {
      await client.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
      const found = await client.query<{ id: string }>("SELECT id FROM users WHERE role='ADMIN' FOR UPDATE");
      expect(found.rows.map((row) => row.id)).toEqual([target.id]);
      await client.query('UPDATE users SET password_hash=$1,password_change_required=TRUE,updated_at=clock_timestamp() WHERE id=$2', [replacement, target.id]);
      await client.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE user_id=$1 AND revoked_at IS NULL', [target.id]);
      await client.query('UPDATE password_reset_tokens SET consumed_at=clock_timestamp() WHERE user_id=$1 AND consumed_at IS NULL', [target.id]);
      await client.query('UPDATE email_verification_tokens SET consumed_at=clock_timestamp() WHERE user_id=$1 AND consumed_at IS NULL', [target.id]);
    });
    const after = await db.query<{ username: string; email: string; email_verified_at: Date; role: string }>('SELECT username,email,email_verified_at,role FROM users WHERE id=$1', [target.id]);
    expect(after.rows[0]).toMatchObject({ ...before.rows[0], role: 'ADMIN' });
    expect((await db.query<{ revoked_at: Date | null }>('SELECT revoked_at FROM sessions WHERE user_id=$1', [target.id])).rows[0].revoked_at).not.toBeNull();
    expect((await db.query<{ consumed_at: Date | null }>('SELECT consumed_at FROM password_reset_tokens WHERE user_id=$1', [target.id])).rows[0].consumed_at).not.toBeNull();
    expect((await db.query<{ consumed_at: Date | null }>('SELECT consumed_at FROM email_verification_tokens WHERE user_id=$1', [target.id])).rows[0].consumed_at).not.toBeNull();
  });
});
