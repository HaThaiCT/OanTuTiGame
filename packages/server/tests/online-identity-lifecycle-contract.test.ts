import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Database } from '../src/persistence/db.js';
import { IdentityService } from '../src/identity/service.js';
import { registerIdentityRoutes } from '../src/identity/routes.js';
import { hashPassword } from '../src/identity/crypto.js';
import type { IdentityMailOptions } from '../src/identity/mail-outbox.js';

const run = `online_identity_contract_${Date.now().toString(36)}`;
const password = 'OnlineIdentityContractPassword2026!';
const mail: IdentityMailOptions = { keyring: { currentKeyId: 'test', keys: new Map([['test', Buffer.alloc(32, 7)]]) }, publicBaseUrl: 'https://arena.example', from: 'arena@example.test', replyTo: 'support@example.test' };

describe('ONLINE identity lifecycle contract regressions', () => {
  const userIds: string[] = [];
  let db: Database;
  let app: FastifyInstance;
  let previousCapacity: unknown;
  let hadCapacity = false;

  beforeAll(async () => {
    db = new Database();
    const existing = await db.query<{value:unknown}>("SELECT value FROM deployment_settings WHERE key='accountCapacity'");
    hadCapacity=existing.rows.length>0; previousCapacity=existing.rows[0]?.value;
    await db.query("INSERT INTO deployment_settings(key,value) VALUES ('accountCapacity',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", ['{"limit":100}']);
    app = Fastify();
    registerIdentityRoutes(app, new IdentityService(db, 'ONLINE', { mail }), ['https://arena.example']);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    for (const id of userIds) {
      await db.query('DELETE FROM sessions WHERE user_id=$1', [id]);
      await db.query('DELETE FROM identity_mail_deliveries WHERE user_id=$1', [id]);
      await db.query('DELETE FROM password_reset_tokens WHERE user_id=$1', [id]);
      await db.query('DELETE FROM email_verification_tokens WHERE user_id=$1', [id]);
      await db.query('DELETE FROM users WHERE id=$1', [id]);
    }
    if(hadCapacity) await db.query("INSERT INTO deployment_settings(key,value) VALUES ('accountCapacity',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[previousCapacity]);
    else await db.query("DELETE FROM deployment_settings WHERE key='accountCapacity'");
    await db.close();
  });

  it('exposes the resolved auth profile without session state and prevents caching', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v2/auth/profile' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ authProfile: 'ONLINE' });
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['set-cookie']).toBeUndefined();
  });
  it('refuses registration when accountCapacity is missing without creating an account', async () => {
    await db.query("DELETE FROM deployment_settings WHERE key='accountCapacity'");
    try {
      const response = await app.inject({ method:'POST', url:'/api/v2/auth/register', headers: { origin: 'https://arena.example' }, payload:{username:`${run}_capacity`,displayName:'Capacity',email:`${run}@example.test`,password} });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('ACCOUNT_CAPACITY_REQUIRED');
      expect((await db.query('SELECT id FROM users WHERE username=$1',[`${run}_capacity`])).rows).toHaveLength(0);
    } finally {
      if(hadCapacity) await db.query("INSERT INTO deployment_settings(key,value) VALUES ('accountCapacity',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [JSON.stringify(previousCapacity)]);
      else await db.query("DELETE FROM deployment_settings WHERE key='accountCapacity'");
    }
  });

  it('fails closed without identity-mail authority and creates no ONLINE ADMIN', async () => {
    const username = `${run}_admin`;
    const identity = new IdentityService(db, 'ONLINE');
    await expect(identity.bootstrapAdmin(username, password, `${username}@example.test`)).rejects.toMatchObject({ code: 'MAIL_DELIVERY_UNAVAILABLE' });
    expect((await db.query('SELECT id FROM users WHERE username=$1', [username])).rows).toHaveLength(0);
  });
  it('initializes accountCapacity atomically when an operator bootstraps the first Online admin', async () => {
    const username = `s${Date.now().toString(36)}_capacity_admin`;
    const capacityBefore = await db.query<{value:unknown}>("SELECT value FROM deployment_settings WHERE key='accountCapacity'");
    await db.query("DELETE FROM deployment_settings WHERE key='accountCapacity'");
    const existingCount = await db.query<{count:string}>('SELECT count(*)::text AS count FROM users');
    const limit = Number(existingCount.rows[0].count) + 2;
    const identity = new IdentityService(db, 'ONLINE', { mail });
    try {
      const created = await identity.bootstrapAdmin(username, password, `${username}@example.test`, limit);
      expect(created.role).toBe('ADMIN');
      expect((await db.query<{value:{limit:number}}>("SELECT value FROM deployment_settings WHERE key='accountCapacity'")).rows[0].value).toEqual({limit});
      expect((await db.query('SELECT id FROM email_verification_tokens WHERE user_id=$1 AND consumed_at IS NULL',[created.id])).rows).toHaveLength(1);
      await db.query('DELETE FROM outbox_events WHERE id IN (SELECT outbox_id FROM identity_mail_deliveries WHERE user_id=$1)',[created.id]);
      await db.query('DELETE FROM users WHERE id=$1',[created.id]);
    } finally {
      if (capacityBefore.rows.length) await db.query("INSERT INTO deployment_settings(key,value) VALUES('accountCapacity',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[JSON.stringify(capacityBefore.rows[0].value)]);
      else await db.query("DELETE FROM deployment_settings WHERE key='accountCapacity'");
    }
  });
  it('rolls back initial Online capacity when the first ADMIN exceeds the limit', async () => {
    const username = `s${Date.now().toString(36)}_full_admin`;
    const baseline = `cap_initial_${Date.now().toString(36)}`;
    await db.query("INSERT INTO users(username,display_name,email,password_hash,role,activation_method) VALUES($1,'Capacity fixture',$2,'fixture-hash','STUDENT','SELF_REGISTER')", [baseline, `${baseline}@example.test`]);
    const capacityBefore = await db.query<{value:unknown}>("SELECT value FROM deployment_settings WHERE key='accountCapacity'");
    const count = await db.query<{count:string}>('SELECT count(*)::text AS count FROM users');
    await db.query("DELETE FROM deployment_settings WHERE key='accountCapacity'");
    try {
      await expect(new IdentityService(db,'ONLINE',{mail}).bootstrapAdmin(username,password,`${username}@example.test`,Number(count.rows[0].count))).rejects.toMatchObject({code:'ACCOUNT_CAPACITY_EXCEEDED'});
      expect((await db.query("SELECT value FROM deployment_settings WHERE key='accountCapacity'")).rows).toHaveLength(0);
      expect((await db.query('SELECT id FROM users WHERE username=$1',[username])).rows).toHaveLength(0);
    } finally {
      await db.query('DELETE FROM users WHERE username=$1', [baseline]);
      if(capacityBefore.rows.length) await db.query("INSERT INTO deployment_settings(key,value) VALUES('accountCapacity',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[JSON.stringify(capacityBefore.rows[0].value)]);
      else await db.query("DELETE FROM deployment_settings WHERE key='accountCapacity'");
    }
  });
  it('creates the ONLINE singleton ADMIN pending verification with capacity and no plaintext password persistence', async () => {
    const username = `s${Date.now().toString(36)}_secure_admin`;
    const countResult = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM users');
    const limit = Number(countResult.rows[0].count) + 1;
    await db.query("INSERT INTO deployment_settings(key,value) VALUES ('accountCapacity',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [JSON.stringify({ limit })]);
    const identity = new IdentityService(db, 'ONLINE', { mail });
    try {
      const created = await identity.bootstrapAdmin(username, password, `${username}@example.test`);
      userIds.push(created.id);
      expect(created.role).toBe('ADMIN');
      const row = await db.query<{ activation_method: string; email_verified_at: Date | null; password_change_required: boolean; password_hash: string }>('SELECT activation_method, email_verified_at, password_change_required, password_hash FROM users WHERE id=$1', [created.id]);
      expect(row.rows[0]).toMatchObject({ activation_method: 'SELF_REGISTER', email_verified_at: null, password_change_required: true });
      expect(row.rows[0].password_hash).not.toBe(password);
      expect(JSON.stringify(row.rows)).not.toContain(password);
      const verification = await db.query('SELECT id FROM email_verification_tokens WHERE user_id=$1 AND consumed_at IS NULL', [created.id]);
      expect(verification.rows).toHaveLength(1);
      await expect(identity.login(username, password)).rejects.toMatchObject({ code: 'EMAIL_VERIFICATION_REQUIRED' });
      await expect(identity.bootstrapAdmin(`${username}_second`, password, `${username}_second@example.test`)).rejects.toMatchObject({ statusCode: 409 });
    } finally {
      await db.query('DELETE FROM users WHERE username=$1', [username]);
    }
  });
  it('recovers the existing ONLINE singleton by rebinding email pending verification and revoking authority', async () => {
    const username = `s${Date.now().toString(36)}_recover`;
    const identity = new IdentityService(db, 'ONLINE', { mail });
    const created = await identity.bootstrapAdmin(username, password, `${username}@example.test`);
    userIds.push(created.id);
    try {
      const beforeToken = await db.query<{ id: string }>('SELECT id FROM email_verification_tokens WHERE user_id=$1 AND consumed_at IS NULL', [created.id]);
      await db.query("UPDATE users SET email_verified_at=clock_timestamp() WHERE id=$1", [created.id]);
      await db.query("INSERT INTO sessions(user_id,token_hash,scope,expires_at) VALUES($1,repeat('a',64),'FULL',clock_timestamp()+interval '1 day')", [created.id]);
      await db.query("INSERT INTO password_reset_tokens(user_id,token_hash,target_email,expires_at) VALUES($1,repeat('b',64),$2,clock_timestamp()+interval '1 hour')", [created.id, `${username}@example.test`]);
      await db.query("UPDATE identity_mail_deliveries SET state='PENDING',envelope='{}'::jsonb WHERE user_id=$1 AND purpose='EMAIL_VERIFICATION'", [created.id]);
      await identity.recoverOnlineAdmin(`${username}@new.example.test`, 'operator reason', 'AUTH-123');
      const rows = await db.query<{ id: string; role: string; email: string; email_verified_at: Date | null }>('SELECT id,role,email,email_verified_at FROM users WHERE role=\'ADMIN\'');
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({ id: created.id, role: 'ADMIN', email: `${username}@new.example.test`, email_verified_at: null });
      expect((await db.query('SELECT id FROM sessions WHERE user_id=$1 AND revoked_at IS NULL', [created.id])).rows).toHaveLength(0);
      expect((await db.query('SELECT id FROM password_reset_tokens WHERE user_id=$1 AND consumed_at IS NULL', [created.id])).rows).toHaveLength(0);
      expect((await db.query('SELECT id FROM email_verification_tokens WHERE user_id=$1 AND consumed_at IS NULL', [created.id])).rows).toHaveLength(1);
      expect((await db.query("SELECT d.outbox_id FROM identity_mail_deliveries d JOIN email_verification_tokens t ON t.user_id=d.user_id AND t.token_hash=d.token_hash WHERE d.user_id=$1 AND d.state='PENDING' AND d.purpose='EMAIL_VERIFICATION' AND t.target_email=$2 AND t.consumed_at IS NULL", [created.id, `${username}@new.example.test`])).rows).toHaveLength(1);
      expect((await db.query("SELECT d.outbox_id FROM identity_mail_deliveries d WHERE d.user_id=$1 AND d.state='CANCELLED' AND d.purpose='EMAIL_VERIFICATION' AND d.envelope IS NULL", [created.id])).rows).toHaveLength(1);
      expect(beforeToken.rows).toHaveLength(1);
    } finally {
      await db.query('DELETE FROM identity_mail_deliveries WHERE user_id=$1', [created.id]);
      await db.query("DELETE FROM outbox_events WHERE payload->>'userId'=$1", [created.id]);
      await db.query('DELETE FROM sessions WHERE user_id=$1', [created.id]);
      await db.query('DELETE FROM password_reset_tokens WHERE user_id=$1', [created.id]);
      await db.query('DELETE FROM email_verification_tokens WHERE user_id=$1', [created.id]);
      await db.query('DELETE FROM users WHERE id=$1', [created.id]);
      userIds.splice(userIds.indexOf(created.id), 1);
    }
  });
  it('creates the ONLINE singleton ADMIN as pending and records delivery material without activating it', async () => {
    const username = `${run}_bootstrap_admin`;
    const countResult = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM users');
    const limit = Number(countResult.rows[0].count) + 1;
    await db.query("INSERT INTO deployment_settings(key,value) VALUES ('accountCapacity',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [JSON.stringify({ limit })]);
    const identity = new IdentityService(db, 'ONLINE', { mail });
    try {
      const created = await identity.bootstrapAdmin(username, password, `${username}@example.test`);
      userIds.push(created.id);
      expect(created.role).toBe('ADMIN');
      const row = await db.query<{ activation_method: string; email_verified_at: Date | null }>('SELECT activation_method, email_verified_at FROM users WHERE id=$1', [created.id]);
      expect(row.rows[0]).toMatchObject({ activation_method: 'SELF_REGISTER', email_verified_at: null });
      const verification = await db.query('SELECT id FROM email_verification_tokens WHERE user_id=$1 AND consumed_at IS NULL', [created.id]);
      expect(verification.rows).toHaveLength(1);
      await expect(identity.login(username, password)).rejects.toMatchObject({ code: 'EMAIL_VERIFICATION_REQUIRED' });
    } finally {
      await db.query('DELETE FROM users WHERE username=$1', [username]);
    }
  });
  it('refuses ONLINE singleton bootstrap when account capacity is exhausted', async () => {
    const username = `${run}_full_bootstrap`;
    const baseline = `cap_existing_${Date.now().toString(36)}`;
    await db.query("INSERT INTO users(username,display_name,email,password_hash,role,activation_method) VALUES($1,'Capacity fixture',$2,'fixture-hash','STUDENT','SELF_REGISTER')", [baseline, `${baseline}@example.test`]);
    const capacityBefore = await db.query<{value:unknown}>("SELECT value FROM deployment_settings WHERE key='accountCapacity'");
    const countResult = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM users');
    await db.query("INSERT INTO deployment_settings(key,value) VALUES ('accountCapacity',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [JSON.stringify({ limit: Number(countResult.rows[0].count) })]);
    try {
      await expect(new IdentityService(db, 'ONLINE', { mail }).bootstrapAdmin(username, password, `${username}@example.test`)).rejects.toMatchObject({ code: 'ACCOUNT_CAPACITY_EXCEEDED' });
      expect((await db.query('SELECT id FROM users WHERE username=$1', [username])).rows).toHaveLength(0);
    } finally {
      await db.query('DELETE FROM users WHERE username=$1', [username]);
      await db.query('DELETE FROM users WHERE username=$1', [baseline]);
      if(capacityBefore.rows.length) await db.query("INSERT INTO deployment_settings(key,value) VALUES('accountCapacity',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[JSON.stringify(capacityBefore.rows[0].value)]);
      else await db.query("DELETE FROM deployment_settings WHERE key='accountCapacity'");
    }
  });
});
