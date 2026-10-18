/**
 * Live spectator stream: the hub's snapshot/event/result contract and the wire route that
 * exposes it (`GET /api/v2/live/:gameId`).
 *
 * These tests use no PostgreSQL and no match execution: the hub is fed by hand, which is exactly
 * what the executor does with `publishTurn`. The route half runs a real Fastify server on an
 * ephemeral port with real WebSocket clients, so the frozen wire shape (SNAPSHOT → EVENT →
 * RESULT, close 4404 for an unknown game) is exercised as the web client will see it.
 *
 * Time is never slept on: frames are awaited as events (`events.once`), the retention timer is
 * driven by fake timers, and the few hub-side conditions without an event to await are observed
 * by yielding the loop until they hold.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import type { MapDescriptor } from '@oantuti/engine';
import {
  LIVE_EVENT_BUFFER_LIMIT,
  LiveMatchHub,
  type LiveServerMessage,
  type LiveSend,
  type LiveTurnInput,
} from '../src/live/live-match-hub.js';
import { registerLiveRoutes } from '../src/live/live-routes.js';

const MAP: MapDescriptor = {
  mapName: 'live-test-map',
  width: 8,
  height: 8,
  validTiles: [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ],
  whiteThrone: [0, 0],
  blackThrone: [7, 7],
  startingPieces: [{ pieceId: 1, owner: 1, type: 0, pos: { x: 0, y: 1 } }],
};

const WHITE_TEAM = { id: 'team-white', name: 'White Wolves' };
const BLACK_TEAM = { id: 'team-black', name: 'Black Bears' };

/** Captures everything a hub sends to one subscriber. */
function recorder(): { readonly messages: LiveServerMessage[]; readonly send: LiveSend } {
  const messages: LiveServerMessage[] = [];
  return { messages, send: (message) => messages.push(message) };
}

function move(turnNumber: number, side: 1 | 2, pieceId: number, target: [number, number]): LiveTurnInput {
  return { turnNumber, side, action: { action: 'MOVE', pieceId, target } };
}

function openRequest(gameId: string) {
  return { gameId, map: MAP, whiteTeam: WHITE_TEAM, blackTeam: BLACK_TEAM };
}

/** Waits for a condition that has no event to await (hub counters), without sleeping. */
async function waitFor(predicate: () => boolean, attempts = 10_000): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (predicate()) return;
    await yieldEventLoop();
  }
  throw new Error('waitFor: condition was never satisfied');
}

function parseFrame(raw: unknown): LiveServerMessage {
  return JSON.parse(String(raw)) as LiveServerMessage;
}

describe('LiveMatchHub', () => {
  it('gives a late joiner a snapshot carrying every event published before it subscribed', () => {
    const gameId = randomUUID();
    const hub = new LiveMatchHub();
    hub.openGame(openRequest(gameId));
    hub.publishTurn(gameId, move(1, 1, 3, [2, 3]));
    hub.publishTurn(gameId, {
      turnNumber: 2,
      side: 2,
      action: { action: 'MOVE', pieceId: 5, target: [4, 4] },
      capture: { attackerId: 5, victimId: 3, pos: { x: 2, y: 3 }, attackerType: 0, victimType: 1 },
    });

    const spectator = recorder();
    const unsubscribe = hub.subscribe(gameId, spectator.send);
    expect(unsubscribe).not.toBeNull();

    expect(spectator.messages).toHaveLength(1);
    const snapshot = spectator.messages[0];
    expect(snapshot).toEqual({
      type: 'SNAPSHOT',
      gameId,
      status: 'RUNNING',
      map: MAP,
      whiteTeam: WHITE_TEAM,
      blackTeam: BLACK_TEAM,
      events: [
        { seq: 1, turnNumber: 1, side: 1, action: { action: 'MOVE', pieceId: 3, target: [2, 3] } },
        {
          seq: 2,
          turnNumber: 2,
          side: 2,
          action: { action: 'MOVE', pieceId: 5, target: [4, 4] },
          capture: { attackerId: 5, victimId: 3, pos: { x: 2, y: 3 }, attackerType: 0, victimType: 1 },
        },
      ],
    });

    // The snapshot survives a JSON round-trip unchanged: it is exactly what the route serializes.
    expect(parseFrame(JSON.stringify(snapshot))).toEqual(snapshot);

    // Events published after the subscribe arrive as EVENT frames, in order.
    hub.publishTurn(gameId, move(3, 1, 3, [1, 1]));
    expect(spectator.messages[1]).toEqual({
      type: 'EVENT',
      gameId,
      seq: 3,
      turnNumber: 3,
      side: 1,
      action: { action: 'MOVE', pieceId: 3, target: [1, 1] },
    });
  });

  it('delivers one published event to both subscribers', () => {
    const gameId = randomUUID();
    const hub = new LiveMatchHub();
    hub.openGame(openRequest(gameId));

    const first = recorder();
    const second = recorder();
    expect(hub.subscribe(gameId, first.send)).not.toBeNull();
    expect(hub.subscribe(gameId, second.send)).not.toBeNull();

    hub.publishTurn(gameId, move(1, 2, 9, [6, 6]));

    for (const spectator of [first, second]) {
      expect(spectator.messages).toHaveLength(2);
      expect(spectator.messages[1]).toEqual({
        type: 'EVENT',
        gameId,
        seq: 1,
        turnNumber: 1,
        side: 2,
        action: { action: 'MOVE', pieceId: 9, target: [6, 6] },
      });
    }
    expect(hub.stats()).toEqual({ games: 1, subscribers: 2 });
  });

  it('stops delivering to an unsubscribed spectator, idempotently', () => {
    const gameId = randomUUID();
    const hub = new LiveMatchHub();
    hub.openGame(openRequest(gameId));

    const leaving = recorder();
    const staying = recorder();
    const unsubscribe = hub.subscribe(gameId, leaving.send)!;
    hub.subscribe(gameId, staying.send);

    unsubscribe();
    unsubscribe();
    expect(hub.stats().subscribers).toBe(1);

    hub.publishTurn(gameId, move(1, 1, 1, [1, 1]));
    expect(leaving.messages).toHaveLength(1); // snapshot only
    expect(staying.messages).toHaveLength(2);

    hub.publishTurn(gameId, { turnNumber: 2, side: 2, action: { action: 'PASS' } });
    expect(leaving.messages).toHaveLength(1);
    expect(staying.messages[2]).toEqual({
      type: 'EVENT',
      gameId,
      seq: 2,
      turnNumber: 2,
      side: 2,
      action: { action: 'PASS' },
    });
  });

  it('marks the game FINISHED, publishes RESULT once, and serves the result to a later joiner', () => {
    const gameId = randomUUID();
    const hub = new LiveMatchHub();
    hub.openGame(openRequest(gameId));

    const live = recorder();
    hub.subscribe(gameId, live.send);
    hub.publishTurn(gameId, move(1, 1, 1, [7, 7]));

    hub.finishGame(gameId, { winner: 1, reason: 'THRONE_BREACH' });
    expect(live.messages[2]).toEqual({ type: 'RESULT', gameId, winner: 1, reason: 'THRONE_BREACH' });

    // A finished game accepts nothing further, and a repeated finish emits no second frame.
    hub.publishTurn(gameId, move(2, 2, 2, [0, 0]));
    hub.finishGame(gameId, { winner: 2, reason: 'EXTINCTION' });
    expect(live.messages).toHaveLength(3);

    const late = recorder();
    expect(hub.subscribe(gameId, late.send)).not.toBeNull();
    expect(late.messages).toEqual([
      {
        type: 'SNAPSHOT',
        gameId,
        status: 'FINISHED',
        map: MAP,
        whiteTeam: WHITE_TEAM,
        blackTeam: BLACK_TEAM,
        events: [{ seq: 1, turnNumber: 1, side: 1, action: { action: 'MOVE', pieceId: 1, target: [7, 7] } }],
        result: { winner: 1, reason: 'THRONE_BREACH' },
      },
    ]);
  });

  it('reports an unknown game for subscribe and ignores publications to it', () => {
    const hub = new LiveMatchHub();
    const spectator = recorder();

    expect(hub.hasGame('no-such-game')).toBe(false);
    expect(hub.subscribe('no-such-game', spectator.send)).toBeNull();

    // Publications for a game the hub never opened are dropped, and no channel appears.
    hub.publishTurn('no-such-game', move(1, 1, 1, [1, 1]));
    hub.finishGame('no-such-game', { winner: null, reason: 'EXECUTION_FAILED' });
    expect(hub.hasGame('no-such-game')).toBe(false);
    expect(spectator.messages).toHaveLength(0);
    expect(hub.stats()).toEqual({ games: 0, subscribers: 0 });
  });

  it('bounds the late-join buffer to the newest events', () => {
    const gameId = randomUUID();
    const hub = new LiveMatchHub();
    hub.openGame(openRequest(gameId));
    for (let turn = 1; turn <= LIVE_EVENT_BUFFER_LIMIT + 50; turn++) {
      hub.publishTurn(gameId, move(turn, turn % 2 === 0 ? 2 : 1, 1, [1, 1]));
    }

    const spectator = recorder();
    hub.subscribe(gameId, spectator.send);
    const snapshot = spectator.messages[0];
    if (snapshot.type !== 'SNAPSHOT') throw new Error('expected a snapshot first');
    expect(snapshot.events).toHaveLength(LIVE_EVENT_BUFFER_LIMIT);
    // Oldest events were evicted: the buffer starts 50 turns in and keeps the newest event.
    expect(snapshot.events[0].turnNumber).toBe(51);
    expect(snapshot.events[snapshot.events.length - 1].turnNumber).toBe(LIVE_EVENT_BUFFER_LIMIT + 50);
  });

  it('refuses subscribers beyond the per-game and global ceilings', () => {
    const perGame = new LiveMatchHub({ maxSubscribersPerGame: 2 });
    const firstGame = randomUUID();
    perGame.openGame(openRequest(firstGame));

    const first = recorder();
    const second = recorder();
    const third = recorder();
    const unsubscribe = perGame.subscribe(firstGame, first.send)!;
    expect(perGame.subscribe(firstGame, second.send)).not.toBeNull();
    expect(perGame.subscribe(firstGame, third.send)).toBeNull();

    // Freeing a slot frees a subscriber.
    unsubscribe();
    expect(perGame.subscribe(firstGame, third.send)).not.toBeNull();
    perGame.dispose();

    const global = new LiveMatchHub({ maxSubscribersTotal: 1 });
    const anotherGame = randomUUID();
    global.openGame(openRequest(firstGame));
    global.openGame(openRequest(anotherGame));
    expect(global.subscribe(firstGame, recorder().send)).not.toBeNull();
    expect(global.subscribe(anotherGame, recorder().send)).toBeNull();
    global.dispose();
  });

  it('retains a finished game for the grace window, then drops it', () => {
    vi.useFakeTimers();
    try {
      const gameId = randomUUID();
      const hub = new LiveMatchHub({ finishedRetentionMs: 25 });
      hub.openGame(openRequest(gameId));

      const spectator = recorder();
      const unsubscribe = hub.subscribe(gameId, spectator.send)!;
      hub.finishGame(gameId, { winner: 2, reason: 'EXTINCTION' });
      expect(hub.hasGame(gameId)).toBe(true);

      vi.advanceTimersByTime(24);
      expect(hub.hasGame(gameId)).toBe(true);
      vi.advanceTimersByTime(1);
      expect(hub.hasGame(gameId)).toBe(false);

      expect(hub.subscribe(gameId, recorder().send)).toBeNull();
      expect(hub.stats()).toEqual({ games: 0, subscribers: 0 });
      // The closed-over unsubscribe of a dropped channel must not corrupt the counter.
      unsubscribe();
      expect(hub.stats().subscribers).toBe(0);
      hub.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-opens a requeued game by re-syncing its subscribers on a fresh snapshot', () => {
    const gameId = randomUUID();
    const hub = new LiveMatchHub();
    hub.openGame(openRequest(gameId));

    const spectator = recorder();
    hub.subscribe(gameId, spectator.send);
    hub.publishTurn(gameId, move(1, 1, 1, [1, 1]));
    hub.finishGame(gameId, { winner: 1, reason: 'THRONE_BREACH' });

    hub.openGame({ ...openRequest(gameId), whiteTeam: { id: 'team-white', name: 'Renamed Wolves' } });

    expect(spectator.messages[3]).toEqual({
      type: 'SNAPSHOT',
      gameId,
      status: 'RUNNING',
      map: MAP,
      whiteTeam: { id: 'team-white', name: 'Renamed Wolves' },
      blackTeam: BLACK_TEAM,
      events: [],
    });
    hub.publishTurn(gameId, move(1, 2, 2, [2, 2]));
    expect(spectator.messages[4]).toMatchObject({ type: 'EVENT', turnNumber: 1, side: 2 });
  });
});

describe('GET /api/v2/live/:gameId (spectator WebSocket route)', () => {
  let app: FastifyInstance;
  let hub: LiveMatchHub;
  let origin: string;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    hub = new LiveMatchHub();
    registerLiveRoutes(app, hub);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    origin = `127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await app.close();
    hub.dispose();
  });

  it('answers a non-upgrade GET with JSON instead of the plugin default', async () => {
    const missing = await app.inject({ method: 'GET', url: `/api/v2/live/${randomUUID()}` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'GAME_NOT_FOUND' });

    const gameId = randomUUID();
    hub.openGame(openRequest(gameId));
    const running = await app.inject({ method: 'GET', url: `/api/v2/live/${gameId}` });
    expect(running.statusCode).toBe(426);
    expect(running.json()).toEqual({ error: 'WEBSOCKET_UPGRADE_REQUIRED', gameId });
  });

  it('streams SNAPSHOT, then each EVENT, then RESULT, and closes the socket', async () => {
    const gameId = randomUUID();
    hub.openGame(openRequest(gameId));
    hub.publishTurn(gameId, move(1, 1, 4, [3, 3]));

    const socket = new WebSocket(`ws://${origin}/api/v2/live/${gameId}`);
    socket.on('error', () => undefined);
    const closed = once(socket, 'close');
    const snapshotFrame = once(socket, 'message');

    const [snapshotRaw] = await snapshotFrame;
    expect(parseFrame(snapshotRaw)).toMatchObject({
      type: 'SNAPSHOT',
      gameId,
      status: 'RUNNING',
      events: [{ seq: 1, turnNumber: 1, side: 1 }],
    });

    const eventFrame = once(socket, 'message');
    hub.publishTurn(gameId, move(2, 2, 7, [5, 5]));
    const [eventRaw] = await eventFrame;
    expect(parseFrame(eventRaw)).toEqual({
      type: 'EVENT',
      gameId,
      seq: 2,
      turnNumber: 2,
      side: 2,
      action: { action: 'MOVE', pieceId: 7, target: [5, 5] },
    });

    const resultFrame = once(socket, 'message');
    hub.finishGame(gameId, { winner: 2, reason: 'EXTINCTION' });
    const [resultRaw] = await resultFrame;
    expect(parseFrame(resultRaw)).toEqual({ type: 'RESULT', gameId, winner: 2, reason: 'EXTINCTION' });

    const [closeCode] = await closed;
    expect(closeCode).toBe(1000);
  });

  it('serves a finished game to a late joiner and closes right after the snapshot', async () => {
    const gameId = randomUUID();
    hub.openGame(openRequest(gameId));
    hub.publishTurn(gameId, move(1, 1, 4, [3, 3]));
    hub.finishGame(gameId, { winner: 1, reason: 'THRONE_BREACH' });

    const socket = new WebSocket(`ws://${origin}/api/v2/live/${gameId}`);
    socket.on('error', () => undefined);
    const snapshotFrame = once(socket, 'message');
    const closed = once(socket, 'close');

    const [snapshotRaw] = await snapshotFrame;
    expect(parseFrame(snapshotRaw)).toEqual({
      type: 'SNAPSHOT',
      gameId,
      status: 'FINISHED',
      map: MAP,
      whiteTeam: WHITE_TEAM,
      blackTeam: BLACK_TEAM,
      events: [{ seq: 1, turnNumber: 1, side: 1, action: { action: 'MOVE', pieceId: 4, target: [3, 3] } }],
      result: { winner: 1, reason: 'THRONE_BREACH' },
    });

    const [closeCode] = await closed;
    expect(closeCode).toBe(1000);
    await waitFor(() => hub.stats().subscribers === 0);
  });

  it('closes an unknown game with 4404', async () => {
    const socket = new WebSocket(`ws://${origin}/api/v2/live/${randomUUID()}`);
    socket.on('error', () => undefined);
    const [closeCode] = await once(socket, 'close');
    expect(closeCode).toBe(4404);
  });

  it('detaches the spectator when the client disconnects', async () => {
    const gameId = randomUUID();
    hub.openGame(openRequest(gameId));

    const socket = new WebSocket(`ws://${origin}/api/v2/live/${gameId}`);
    socket.on('error', () => undefined);
    // The snapshot is sent from inside subscribe, so receiving it proves the spectator is attached.
    await once(socket, 'message');
    expect(hub.stats().subscribers).toBe(1);

    const closed = once(socket, 'close');
    socket.close();
    await closed;
    await waitFor(() => hub.stats().subscribers === 0);
  });
});
