import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type AppContext } from '../src/app.js';

interface RegisteredPlayer {
  readonly cookie: string;
  readonly userId: string;
  readonly username: string;
}

interface MatchEntry {
  readonly id: string;
  readonly winner_side?: string;
  readonly total_turns?: number;
}

interface StandingRow {
  readonly botId: string;
  readonly botName: string;
  readonly matchesPlayed: number;
  readonly points: number;
  readonly wins: number;
}

interface TournamentDetailsResponse {
  readonly tournament: {
    readonly id: string;
    readonly name: string;
    readonly status: string;
    readonly config_json: string;
  };
  readonly standings: readonly StandingRow[];
  readonly matches: readonly MatchEntry[];
}

interface LoginResponse {
  readonly user: {
    readonly id: string;
    readonly username: string;
    readonly role: string;
  };
}

interface TournamentCreateResponse {
  readonly tournament: {
    readonly id: string;
    readonly status: string;
  };
}

interface BotCreateResponse {
  readonly bot: {
    readonly id: string;
  };
}

interface ProjectNextResponse {
  readonly success: boolean;
  readonly projectedIndex: number;
}

describe('End-to-End Multi-User LAN Tournament Simulation with RBAC', () => {
  let dir: string;
  let ctx: AppContext;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'arena-lan-e2e-'));
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

  async function registerPlayer(username: string): Promise<RegisteredPlayer> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        username,
        email: `${username}@lan.party`,
        password: 'secure-password-12345',
      },
    });
    const body = res.json() as LoginResponse;
    expect(body.user.role).toBe('PLAYER');
    const cookie = String(res.headers['set-cookie']).split(';')[0];
    return { cookie, userId: body.user.id, username: body.user.username };
  }

  it('runs complete multi-user LAN workflow: registration, code submission, owner lock, and anti-spoiler projection', async () => {
    // 1. Admin login with default credentials
    const adminLoginRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'admin123' },
    });
    expect(adminLoginRes.statusCode).toBe(200);
    const adminData = adminLoginRes.json() as LoginResponse;
    expect(adminData.user.role).toBe('ADMIN');
    const adminCookie = String(adminLoginRes.headers['set-cookie']).split(';')[0];

    // 2. Admin creates an open registration tournament
    const tourCreateRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/tournaments',
      headers: { cookie: adminCookie },
      payload: {
        name: 'LAN Champions 2026',
        mapId: 'sample-donut',
        format: 'ROUND_ROBIN',
        registrationOnly: true,
      },
    });
    expect(tourCreateRes.statusCode).toBe(200);
    const tourData = tourCreateRes.json() as TournamentCreateResponse;
    const tourId = tourData.tournament.id;

    // 3. Player 1 registers from their laptop, creates a bot, and submits to the tournament
    const player1 = await registerPlayer('lan_player_alice');
    const botCode1 = 'import sys,json\nfor l in sys.stdin:\n m=json.loads(l)\n print(json.dumps({"status":"READY"} if m["type"]=="INIT" else {"action":"PASS"}),flush=True)';
    const bot1Res = await ctx.app.inject({
      method: 'POST',
      url: '/api/bots',
      headers: { cookie: player1.cookie },
      payload: { name: 'AliceRock', language: 'PYTHON', sourceCode: botCode1 },
    });
    expect(bot1Res.statusCode).toBe(201);
    const bot1Data = bot1Res.json() as BotCreateResponse;
    const bot1Id = bot1Data.bot.id;

    const entry1Res = await ctx.app.inject({
      method: 'POST',
      url: `/api/tournaments/${tourId}/entries`,
      headers: { cookie: player1.cookie },
      payload: { botId: bot1Id },
    });
    expect(entry1Res.statusCode).toBe(200);

    // 4. Player 2 registers from their laptop, creates a bot, and submits to the tournament
    const player2 = await registerPlayer('lan_player_bob');
    const botCode2 = 'import sys,json\nfor l in sys.stdin:\n m=json.loads(l)\n print(json.dumps({"status":"READY"} if m["type"]=="INIT" else {"action":"PASS"}),flush=True)';
    const bot2Res = await ctx.app.inject({
      method: 'POST',
      url: '/api/bots',
      headers: { cookie: player2.cookie },
      payload: { name: 'BobScissors', language: 'PYTHON', sourceCode: botCode2 },
    });
    expect(bot2Res.statusCode).toBe(201);
    const bot2Data = bot2Res.json() as BotCreateResponse;
    const bot2Id = bot2Data.bot.id;

    const entry2Res = await ctx.app.inject({
      method: 'POST',
      url: `/api/tournaments/${tourId}/entries`,
      headers: { cookie: player2.cookie },
      payload: { botId: bot2Id },
    });
    expect(entry2Res.statusCode).toBe(200);

    // 5. Player 1 attempts to lock the tournament -> rejected with 403 Forbidden
    const illegalLockRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/tournaments/${tourId}/lock`,
      headers: { cookie: player1.cookie },
      payload: {},
    });
    expect(illegalLockRes.statusCode).toBe(403);

    // 6. Admin locks tournament roster -> tournament computes in background
    const tournamentComplete = Promise.withResolvers<void>();
    ctx.tournamentService.once('tournament:complete', () => tournamentComplete.resolve());

    const lockRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/tournaments/${tourId}/lock`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(lockRes.statusCode).toBe(200);

    await tournamentComplete.promise;

    // 7. Check Anti-Spoiler state on Player 1's laptop before projection
    const playerViewInitialRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/tournaments/${tourId}`,
      headers: { cookie: player1.cookie },
    });
    expect(playerViewInitialRes.statusCode).toBe(200);
    const playerViewInitial = playerViewInitialRes.json() as TournamentDetailsResponse;
    // Matches are hidden until Admin projects them
    expect(playerViewInitial.matches.length).toBe(0);
    expect(playerViewInitial.standings.every(s => s.matchesPlayed === 0 && s.points === 0)).toBe(true);

    // 8. Admin on projector screen projects the first match (Next Match clicked)
    const projectNextRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/tournaments/${tourId}/project-next`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(projectNextRes.statusCode).toBe(200);
    const projectNextData = projectNextRes.json() as ProjectNextResponse;
    expect(projectNextData.projectedIndex).toBe(1);

    // 9. Now Player 1 on their laptop queries again: match 1 is revealed, standings reflect match 1
    const playerViewUpdatedRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/tournaments/${tourId}`,
      headers: { cookie: player1.cookie },
    });
    expect(playerViewUpdatedRes.statusCode).toBe(200);
    const playerViewUpdated = playerViewUpdatedRes.json() as TournamentDetailsResponse;
    expect(playerViewUpdated.matches.length).toBe(1);
    expect(playerViewUpdated.standings.some(s => s.matchesPlayed > 0)).toBe(true);

    // 10. Admin query sees all data regardless of projection
    const adminViewRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/tournaments/${tourId}`,
      headers: { cookie: adminCookie },
    });
    const adminView = adminViewRes.json() as TournamentDetailsResponse;
    expect(adminView.matches.length).toBeGreaterThanOrEqual(1);
  });
});
