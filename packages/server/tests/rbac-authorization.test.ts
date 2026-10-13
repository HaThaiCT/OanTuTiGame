import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type AppContext } from '../src/app.js';

describe('Backend RBAC Authorization & Anti-Spoiler Protection Gate', () => {
  let dir: string;
  let ctx: AppContext;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'arena-rbac-'));
    ctx = await createApp({
      botsDir: join(dir, 'bots'),
      replaysDir: join(dir, 'replays'),
    });
  });

  afterEach(async () => {
    await ctx.app.close();
    ctx.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function loginAdmin(): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'admin123' },
    });
    expect(res.statusCode).toBe(200);
    return String(res.headers['set-cookie']).split(';')[0];
  }

  async function registerPlayer(username: string): Promise<{ cookie: string; user: { id: string; username: string; email: string; role: string } }> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        username,
        email: `${username}@example.com`,
        password: 'password12345',
      },
    });
    expect(res.statusCode).toBe(201);
    const user = res.json().user;
    const cookie = String(res.headers['set-cookie']).split(';')[0];
    return { cookie, user };
  }

  it('forces role PLAYER on self-registration and rejects privilege escalation payloads', async () => {
    // Escalation payload with forbidden role field must be rejected with 400
    const escalationRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        username: 'sneaky_hacker',
        email: 'hacker@example.com',
        password: 'password12345',
        role: 'ADMIN',
      },
    });
    expect(escalationRes.statusCode).toBe(400);

    const { user } = await registerPlayer('valid_player');
    expect(user.role).toBe('PLAYER');

    const meRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: (await registerPlayer('player_check')).cookie },
    });
    expect(meRes.json().user.role).toBe('PLAYER');
  });

  it('rejects player attempts to create tournaments with 403 Forbidden', async () => {
    const { cookie: playerCookie } = await registerPlayer('normal_player');

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/tournaments',
      headers: { cookie: playerCookie },
      payload: {
        name: 'Illegal Tournament',
        mapId: 'sample-donut',
        format: 'ROUND_ROBIN',
        registrationOnly: true,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain('Admin privilege required');
  });

  it('allows admin to create tournaments and rejects player from locking or project-next', async () => {
    const adminCookie = await loginAdmin();
    const { cookie: playerCookie } = await registerPlayer('player_one');

    // Admin creates tournament
    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/tournaments',
      headers: { cookie: adminCookie },
      payload: {
        name: 'Official Championship',
        mapId: 'sample-donut',
        format: 'ROUND_ROBIN',
        registrationOnly: true,
      },
    });
    expect(createRes.statusCode).toBe(200);
    const tourId = createRes.json().tournament.id;

    // Player attempts to lock roster -> 403
    const lockRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/tournaments/${tourId}/lock`,
      headers: { cookie: playerCookie },
      payload: {},
    });
    expect(lockRes.statusCode).toBe(403);

    // Player attempts to advance projection -> 403
    const projectRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/tournaments/${tourId}/project-next`,
      headers: { cookie: playerCookie },
      payload: {},
    });
    expect(projectRes.statusCode).toBe(403);

    // Admin calls project-next -> 200
    const adminProjectRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/tournaments/${tourId}/project-next`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(adminProjectRes.statusCode).toBe(200);
    expect(adminProjectRes.json().projectedIndex).toBe(1);
  });

  it('masks matches and standings for player until admin projects them', async () => {
    const adminCookie = await loginAdmin();
    const { cookie: p1Cookie } = await registerPlayer('player_alpha');
    const { cookie: p2Cookie } = await registerPlayer('player_beta');

    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/tournaments',
      headers: { cookie: adminCookie },
      payload: {
        name: 'Anti-Spoiler Cup',
        mapId: 'sample-donut',
        format: 'ROUND_ROBIN',
        registrationOnly: true,
      },
    });
    const tourId = createRes.json().tournament.id;

    const botCode = 'import sys,json\nfor l in sys.stdin:\n m=json.loads(l)\n print(json.dumps({"status":"READY"} if m["type"]=="INIT" else {"action":"PASS"}),flush=True)';
    const b1 = (await ctx.app.inject({ method: 'POST', url: '/api/bots', headers: { cookie: p1Cookie }, payload: { name: 'B1', language: 'PYTHON', sourceCode: botCode } })).json().bot;
    const b2 = (await ctx.app.inject({ method: 'POST', url: '/api/bots', headers: { cookie: p2Cookie }, payload: { name: 'B2', language: 'PYTHON', sourceCode: botCode } })).json().bot;

    await ctx.app.inject({ method: 'POST', url: `/api/tournaments/${tourId}/entries`, headers: { cookie: p1Cookie }, payload: { botId: b1.id } });
    await ctx.app.inject({ method: 'POST', url: `/api/tournaments/${tourId}/entries`, headers: { cookie: p2Cookie }, payload: { botId: b2.id } });

    const complete = Promise.withResolvers<void>();
    ctx.tournamentService.once('tournament:complete', () => complete.resolve());
    await ctx.app.inject({ method: 'POST', url: `/api/tournaments/${tourId}/lock`, headers: { cookie: adminCookie }, payload: {} });
    await complete.promise;

    // Immediately after completion, projectedIndex is 0
    // Admin query sees full matches
    const adminDetails = (await ctx.app.inject({ method: 'GET', url: `/api/tournaments/${tourId}`, headers: { cookie: adminCookie } })).json();
    expect(adminDetails.matches.length).toBeGreaterThan(0);

    // Player query at projectedIndex 0 sees 0 revealed matches and initial standings
    const playerDetails0 = (await ctx.app.inject({ method: 'GET', url: `/api/tournaments/${tourId}`, headers: { cookie: p1Cookie } })).json();
    expect(playerDetails0.matches.length).toBe(0);

    // Admin advances projection to 1
    await ctx.app.inject({ method: 'POST', url: `/api/tournaments/${tourId}/project-next`, headers: { cookie: adminCookie }, payload: {} });

    // Player query now sees 1 revealed match
    const playerDetails1 = (await ctx.app.inject({ method: 'GET', url: `/api/tournaments/${tourId}`, headers: { cookie: p1Cookie } })).json();
    expect(playerDetails1.matches.length).toBe(1);
  });
});
