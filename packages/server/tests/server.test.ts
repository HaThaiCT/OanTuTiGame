import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { createApp, AppContext } from '../src/app.js';
import {
  decodeWebSocketFrame,
  decodeMatchInitFrame,
  decodeTurnDeltaFrame,
  decodeMatchEndFrame,
  unpackReplay,
  WebSocketMessageType,
} from '@oantuti/protocol';

describe('Fastify HTTP REST API & Binary WebSocket Hub Suite', () => {
  let context: AppContext;
  let serverAddress: string;
  let port: number;

  beforeAll(async () => {
    context = await createApp();
    serverAddress = await context.app.listen({ port: 0, host: '127.0.0.1' });
    const address = context.app.server.address();
    port = typeof address === 'object' && address ? address.port : 3001;
  });

  afterAll(async () => {
    await context.app.close();
    context.db.close();
  });

  it('GET /api/health returns 200 OK', async () => {
    const res = await context.app.inject({
      method: 'GET',
      url: '/api/health',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body.timestamp).toBeDefined();
  });

  it('GET /api/maps returns available maps including sample-donut', async () => {
    const res = await context.app.inject({
      method: 'GET',
      url: '/api/maps',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.maps)).toBe(true);
    expect(body.maps.some((m: { id: string }) => m.id === 'sample-donut')).toBe(true);
  });

  it('GET /api/maps/sample-donut returns map descriptor', async () => {
    const res = await context.app.inject({
      method: 'GET',
      url: '/api/maps/sample-donut',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.mapName).toBe('Donut Citadel');
    expect(body.width).toBe(8);
  });

  it('GET /api/bots returns seeded GreedyBot and RandomBot', async () => {
    const res = await context.app.inject({
      method: 'GET',
      url: '/api/bots',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.bots.length).toBeGreaterThanOrEqual(2);
    expect(body.bots.some((b: { name: string }) => b.name === 'GreedyBot')).toBe(true);
    expect(body.bots.some((b: { name: string }) => b.name === 'RandomBot')).toBe(true);
  });

  it('POST /api/bots registers a new custom bot', async () => {
    const res = await context.app.inject({
      method: 'POST',
      url: '/api/bots',
      payload: {
        name: 'MinimaxBot',
        language: 'PYTHON',
        sourceCode: 'def on_turn(): pass',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.bot.name).toBe('MinimaxBot');
    expect(body.bot.language).toBe('PYTHON');
  });

  it('executes match, streams binary WebSocket frames, and provides replay', async () => {
    const bots = context.db.listBots();
    const greedyBot = bots.find((b) => b.name === 'GreedyBot')!;
    const randomBot = bots.find((b) => b.name === 'RandomBot')!;

    // 1. Start match
    const createRes = await context.app.inject({
      method: 'POST',
      url: '/api/matches',
      payload: {
        mapId: 'sample-donut',
        whiteBotId: greedyBot.id,
        blackBotId: randomBot.id,
        maxTurns: 30,
      },
    });

    expect(createRes.statusCode).toBe(200);
    const { matchId, status } = JSON.parse(createRes.body);
    expect(matchId).toBeDefined();
    expect(status).toBe('RUNNING');

    // 2. Connect WebSocket client
    const wsUrl = `ws://127.0.0.1:${port}/ws/matches/${matchId}`;
    const ws = new WebSocket(wsUrl);

    const receivedFrameTypes: number[] = [];

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        // Send heartbeat ping
        const pingPayload = new Uint8Array([1, 2, 3]);
        const pingFrame = new Uint8Array(5 + 3);
        pingFrame[0] = WebSocketMessageType.MSG_PING;
        new DataView(pingFrame.buffer).setUint32(1, 3, false);
        pingFrame.set(pingPayload, 5);
        ws.send(pingFrame);
      });

      ws.on('message', (data: Buffer) => {
        const buf = new Uint8Array(data);
        const { type, payload } = decodeWebSocketFrame(buf);
        receivedFrameTypes.push(type);

        if (type === WebSocketMessageType.MSG_INIT) {
          const init = decodeMatchInitFrame(payload);
          expect(init.matchId).toBe(matchId);
        } else if (type === WebSocketMessageType.MSG_DELTA) {
          const delta = decodeTurnDeltaFrame(payload);
          expect(delta.turnNumber).toBeGreaterThan(0);
        } else if (type === WebSocketMessageType.MSG_END) {
          const end = decodeMatchEndFrame(payload);
          expect(end.matchId).toBe(matchId);
          ws.close();
          resolve();
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    expect(receivedFrameTypes).toContain(WebSocketMessageType.MSG_INIT);
    expect(receivedFrameTypes).toContain(WebSocketMessageType.MSG_DELTA);
    expect(receivedFrameTypes).toContain(WebSocketMessageType.MSG_END);

    // 3. Test Catch-up Invariant: a second spectator connects to completed match
    const catchupWs = new WebSocket(wsUrl);
    const catchupTypes: number[] = [];

    await new Promise<void>((resolve, reject) => {
      catchupWs.on('message', (data: Buffer) => {
        const buf = new Uint8Array(data);
        const { type } = decodeWebSocketFrame(buf);
        catchupTypes.push(type);

        if (type === WebSocketMessageType.MSG_END) {
          catchupWs.close();
          resolve();
        }
      });

      catchupWs.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    expect(catchupTypes[0]).toBe(WebSocketMessageType.MSG_INIT);
    expect(catchupTypes).toContain(WebSocketMessageType.MSG_DELTA);
    expect(catchupTypes[catchupTypes.length - 1]).toBe(WebSocketMessageType.MSG_END);

    // 4. Download binary replay
    const replayRes = await context.app.inject({
      method: 'GET',
      url: `/api/matches/${matchId}/replay`,
    });

    expect(replayRes.statusCode).toBe(200);
    expect(replayRes.headers['content-type']).toBe('application/octet-stream');
    const replayBuffer = new Uint8Array(replayRes.rawPayload);
    const unpacked = unpackReplay(replayBuffer);
    expect(unpacked.init.matchId).toBe(matchId);
    expect(unpacked.deltas.length).toBeGreaterThan(0);
    expect(unpacked.end.matchId).toBe(matchId);

    // 5. Check ELO leaderboard updated
    const eloRes = await context.app.inject({
      method: 'GET',
      url: '/api/leaderboard',
    });
    expect(eloRes.statusCode).toBe(200);
    const { leaderboard } = JSON.parse(eloRes.body);
    expect(leaderboard.length).toBeGreaterThanOrEqual(2);
    expect(leaderboard.some((b: { matches_played: number }) => b.matches_played > 0)).toBe(true);
  }, 15000);
});
