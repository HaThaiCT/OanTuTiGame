import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { protectMutations } from '../src/auth.js';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../src/identity/crypto.js';
import { IdentityService } from '../src/identity/service.js';
import { TeamService } from '../src/teams/service.js';

import { createApp, type AppContext } from '../src/app.js';
import { PostgresDatabase } from '../src/persistence/db.js';
import type { OnlineConfig } from '../src/identity/online-config.js';

describe('ONLINE full-app integration boundaries', () => {
  it('rejects non-configured origins on ONLINE auth mutations', async () => {
    const app = Fastify();
    protectMutations(app, ['https://arena.example.test'], { exactOrigin: true });
    app.post('/api/v2/auth/login', async () => ({ accepted: true }));
    try {
      const denied = await app.inject({ method: 'POST', url: '/api/v2/auth/login', headers: { origin: 'https://other.example.test' }, payload: {} });
      expect(denied.statusCode).toBe(403);
    } finally { await app.close(); }
  });

  it('requires injected Online configuration and reports profile and mail readiness', async () => {
    const db = new PostgresDatabase();
    const config: OnlineConfig = { publicBaseUrl: 'https://arena.example.test', allowedOrigins: ['https://arena.example.test'], smtp: { host: 'smtp.invalid', port: 465, tlsMode: 'implicit', user: 'u', password: 'p' }, from: 'arena@example.test', replyTo: 'support@example.test', keyring: { currentKeyId: 'k', keys: new Map([['k', Buffer.alloc(32, 7)]]) }, trustedProxies: [], localDemoSkipEmailVerification: false };
    const sent: unknown[] = [];
    const onlineEnvKeys = ['OANTUTI_AUTH_PROFILE','OANTUTI_PUBLIC_BASE_URL','OANTUTI_SMTP_HOST','OANTUTI_SMTP_PORT','OANTUTI_SMTP_TLS_MODE','OANTUTI_SMTP_USER','OANTUTI_SMTP_PASSWORD_FILE','OANTUTI_MAIL_KEYRING_FILE','OANTUTI_MAIL_FROM','OANTUTI_MAIL_REPLY_TO','OANTUTI_TRUST_PROXY','OANTUTI_ALLOWED_ORIGINS'] as const;
    const priorEnv = new Map(onlineEnvKeys.map(key => [key, process.env[key]]));
    for (const key of onlineEnvKeys) delete process.env[key];
    process.env.OANTUTI_AUTH_PROFILE = 'ONLINE';
    try { await expect(createApp({ pgDb: db })).rejects.toThrow(); }
    finally { for (const key of onlineEnvKeys) { const value=priorEnv.get(key); if(value===undefined) delete process.env[key]; else process.env[key]=value; } }
    let context: AppContext | undefined;
    try {
      context = await createApp({ pgDb: db, onlineConfig: config, mailTransport: { send: async (message: unknown) => { sent.push(message); } } });
      const ready = await context.app.inject('/api/health/ready');
      expect(ready.json().checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'mail', ok: true })]));
      const profile = await context.app.inject('/api/v2/auth/profile');
      expect(profile.json()).toEqual({ authProfile: 'ONLINE' });
      expect(sent).toEqual([]);
    } finally {
      if (context) await context.app.close();
      await db.close();
    }
  });
  it('returns a safe membership conflict code when a student creates a second team in the same tournament', async () => {
    const db = new PostgresDatabase();
    const config: OnlineConfig = { publicBaseUrl: 'https://arena.example.test', allowedOrigins: ['https://arena.example.test'], smtp: { host: 'smtp.invalid', port: 465, tlsMode: 'implicit', user: 'u', password: 'p' }, from: 'arena@example.test', replyTo: 'support@example.test', keyring: { currentKeyId: 'k', keys: new Map([['k', Buffer.alloc(32, 8)]]) }, trustedProxies: [], localDemoSkipEmailVerification: false };
    const studentId = randomUUID(), username = `team_error_${randomUUID().replaceAll('-','')}`;
    const student = {userId:studentId,username,role:'STUDENT' as const,teamIds:[] as string[],scope:'FULL' as const};
    const organizer = {userId:randomUUID(),username:'team_error_admin',role:'ADMIN' as const,teamIds:[] as string[],scope:'FULL' as const};
    const teams = new TeamService(db,'ONLINE'); let context: AppContext | undefined;
    let tournamentId: string | undefined; let courseId: string | undefined;
    try {
      await db.query("INSERT INTO users(id,username,display_name,email,password_hash,role,activation_method,email_verified_at) VALUES($1,$2,'Student',$3,$4,'STUDENT','SELF_REGISTER',clock_timestamp())",[studentId,username,`${username}@example.test`,await hashPassword('TeamErrorSmokePassword2026!')]);
      const course=await teams.createCourse(`TE_${studentId.slice(0,8)}`,'Team error smoke',organizer); courseId=course.id;
      const tournament=await teams.createTournament({courseId:course.id,name:`Team error ${studentId.slice(0,8)}`,format:'ROUND_ROBIN',maxTeams:8,minTeamSize:1,maxTeamSize:3},organizer); tournamentId=tournament.id;
      await teams.publishTournament(tournament.id,organizer); await teams.openRegistration(tournament.id,undefined,undefined,organizer);
      await teams.createOwnTeam(tournament.id,'First team',student);
      const identity=new IdentityService(db,'ONLINE');
      const session=await identity.login(username,'TeamErrorSmokePassword2026!');
      context=await createApp({pgDb:db,onlineConfig:config,mailTransport:{send:async()=>{}}});
      const response=await context.app.inject({method:'POST',url:'/api/v2/me/teams',headers:{origin:config.publicBaseUrl,cookie:`oantuti_session=${session.token}`},payload:{tournamentId:tournament.id,name:'Second team'}});
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({code:'TEAM_MEMBERSHIP_CONFLICT',message:expect.any(String)});
      expect((await db.query('SELECT id FROM teams WHERE tournament_id=$1 AND captain_user_id=$2',[tournament.id,studentId])).rows).toHaveLength(1);
    } finally {
      if(context) await context.app.close();
      await db.query('DELETE FROM audit_events WHERE actor_user_id=$1',[studentId]);
      if(tournamentId) await db.query('DELETE FROM teams WHERE tournament_id=$1',[tournamentId]);
      if(tournamentId) await db.query('DELETE FROM tournaments WHERE id=$1',[tournamentId]);
      if(courseId) await db.query('DELETE FROM courses WHERE id=$1',[courseId]);
      await db.query('DELETE FROM users WHERE id=$1',[studentId]);
      await db.close();
    }
  });

  it('marks actual ONLINE session cookies Secure regardless of forwarded protocol', async () => {
    const db = new PostgresDatabase();
    const config: OnlineConfig = { publicBaseUrl: 'https://arena.example.test', allowedOrigins: ['https://arena.example.test'], smtp: { host: 'smtp.invalid', port: 465, tlsMode: 'implicit', user: 'u', password: 'p' }, from: 'arena@example.test', replyTo: 'support@example.test', keyring: { currentKeyId: 'k', keys: new Map([['k', Buffer.alloc(32, 8)]]) }, trustedProxies: ['127.0.0.1'], localDemoSkipEmailVerification: false };
    let context: AppContext | undefined;
    let userId: string | undefined;
    const username = `secure_cookie_${randomUUID().replaceAll('-', '')}`;
    try {
      const passwordHash = await hashPassword('SecureCookiePassword123!');
      const user = await db.query<{ id: string }>("INSERT INTO users (username,display_name,email,password_hash,role,activation_method,password_change_required,email_verified_at) VALUES ($1,'Secure Cookie Test',$2,$3,'ADMIN','SELF_REGISTER',FALSE,now()) RETURNING id", [username, `${username}@example.test`, passwordHash]);
      userId = user.rows[0].id;
      context = await createApp({ pgDb: db, onlineConfig: config, mailTransport: { send: async () => {} } });
      const response = await context.app.inject({ method: 'POST', url: '/api/v2/auth/login', headers: { origin: config.publicBaseUrl, 'x-forwarded-proto': 'http' }, remoteAddress: '127.0.0.1', payload: { username, password: 'SecureCookiePassword123!' } });
      expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
      expect(response.headers['set-cookie']).toContain('Secure');
      expect(response.headers['set-cookie']).toContain('HttpOnly');
    } finally {
      if (userId) await db.query('DELETE FROM users WHERE id=$1', [userId]);
      if (context) await context.app.close();
      await db.close();
    }
  });

});
// These catch an ONLINE policy accidentally reusing LAN private-network trust or Host authority.
describe('ONLINE exact-origin mutation boundary', () => {
  async function request(origin?: string, host = 'arena.example.test') {
    const app = Fastify();
    protectMutations(app, ['https://arena.example.test'], { exactOrigin: true });
    app.post('/operation', async () => ({ accepted: true }));
    try {
      return await app.inject({ method: 'POST', url: '/operation', headers: { host, ...(origin ? { origin } : {}) }, payload: {} });
    } finally { await app.close(); }
  }

  it.each([undefined, 'http://192.168.1.2', 'http://localhost:4300', 'https://foreign.example.test', 'null', 'https://arena.example.test/path'])('refuses untrusted Origin %s even on a private network', async (origin) => {
    expect((await request(origin)).statusCode).toBe(403);
  });

  it('does not authorize the caller-supplied Host as an origin', async () => {
    expect((await request('https://attacker.example.test', 'attacker.example.test')).statusCode).toBe(403);
  });

  it('permits the exact configured HTTPS origin through an internal HTTP proxy hop', async () => {
    expect((await request('https://arena.example.test', 'internal-api:4304')).json()).toEqual({ accepted: true });
  });
  it('keeps localhost aliases distinct unless the validated local-demo option is enabled', async () => {
    const normal = Fastify();
    protectMutations(normal, ['https://localhost:14443'], { exactOrigin: true });
    normal.post('/register', async () => ({ accepted: true }));
    const localDemo = Fastify();
    protectMutations(localDemo, ['https://localhost:14443', 'https://127.0.0.1:14443'], { exactOrigin: true, allowCrossSiteForExactOrigin: true });
    localDemo.post('/register', async () => ({ accepted: true }));
    try {
      const normalAlias = await normal.inject({ method: 'POST', url: '/register', headers: { origin: 'https://127.0.0.1:14443' }, payload: {} });
      const demoAlias = await localDemo.inject({ method: 'POST', url: '/register', headers: { origin: 'https://127.0.0.1:14443' }, payload: {} });
      const browserAlias = await localDemo.inject({ method: 'POST', url: '/register', headers: { origin: 'https://127.0.0.1:14443', 'sec-fetch-site': 'cross-site' }, payload: {} });
      const foreignOrigin = await localDemo.inject({ method: 'POST', url: '/register', headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }, payload: {} });
      expect(normalAlias.statusCode).toBe(403);
      expect(demoAlias.statusCode).toBe(200);
      expect(browserAlias.statusCode).toBe(200);
      expect(foreignOrigin.statusCode).toBe(403);
    } finally { await normal.close(); await localDemo.close(); }
  });
});
