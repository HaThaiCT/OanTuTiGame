import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp, AppContext } from '../src/app.js';

describe('Tournament Engine & Automated Matchmaking Suite', () => {
  let context: AppContext;

  beforeAll(async () => {
    context = await createApp();
    await context.app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await context.app.close();
    context.db.close();
  });

  it('rejects tournament creation with fewer than 2 bots', async () => {
    const res = await context.app.inject({
      method: 'POST',
      url: '/api/tournaments',
      payload: {
        name: 'Invalid Tournament',
        mapId: 'sample-donut',
        botIds: ['only_one_bot'],
      },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('at least 2 bots');
  });

  it('creates and executes an automated Round-Robin tournament between 3 bots', async () => {
    const bots = context.db.listBots();
    expect(bots.length).toBeGreaterThanOrEqual(3);

    const participatingBotIds = [bots[0].id, bots[1].id, bots[2].id];

    // 1. Create Tournament via REST API
    const createRes = await context.app.inject({
      method: 'POST',
      url: '/api/tournaments',
      payload: {
        name: 'OanTuTi Autumn Championship',
        format: 'ROUND_ROBIN',
        mapId: 'sample-donut',
        botIds: participatingBotIds,
        maxTurns: 30,
        doubleRound: false,
      },
    });

    expect(createRes.statusCode).toBe(200);
    const { tournament } = JSON.parse(createRes.body);
    expect(tournament.id).toBeDefined();
    expect(tournament.name).toBe('OanTuTi Autumn Championship');
    expect(tournament.format).toBe('ROUND_ROBIN');

    // 2. Wait for tournament to complete via event
    await new Promise<void>((resolve, reject) => {
      const onComplete = (event: { tournamentId: string }) => {
        if (event.tournamentId === tournament.id) {
          context.tournamentService.off('tournament:complete', onComplete);
          context.tournamentService.off('tournament:error', onError);
          resolve();
        }
      };
      const onError = (event: { tournamentId: string; error: unknown }) => {
        if (event.tournamentId === tournament.id) {
          context.tournamentService.off('tournament:complete', onComplete);
          context.tournamentService.off('tournament:error', onError);
          reject(event.error);
        }
      };
      context.tournamentService.on('tournament:complete', onComplete);
      context.tournamentService.on('tournament:error', onError);
    });

    // 3. Query Tournament Details
    const detailsRes = await context.app.inject({
      method: 'GET',
      url: `/api/tournaments/${tournament.id}`,
    });

    expect(detailsRes.statusCode).toBe(200);
    const details = JSON.parse(detailsRes.body);

    expect(details.tournament.status).toBe('COMPLETED');
    expect(details.tournament.finished_at).toBeDefined();

    // 3 bots single round robin = 3 matches
    expect(details.matches.length).toBe(3);
    for (const m of details.matches) {
      expect(m.finished_at).toBeDefined();
      expect(m.winner_side).toBeDefined();
      expect(m.total_turns).toBeGreaterThan(0);
    }

    // Standings verification
    expect(details.standings.length).toBe(3);
    const topBot = details.standings[0];
    expect(topBot.points).toBeGreaterThanOrEqual(details.standings[1].points);
    expect(topBot.matchesPlayed).toBe(2);

    // 4. List Tournaments API
    const listRes = await context.app.inject({
      method: 'GET',
      url: '/api/tournaments',
    });
    expect(listRes.statusCode).toBe(200);
    const { tournaments } = JSON.parse(listRes.body);
    expect(tournaments.some((t: { id: string }) => t.id === tournament.id)).toBe(true);
  }, 30000);
});
