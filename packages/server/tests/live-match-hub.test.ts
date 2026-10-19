/**
 * Live spectator stream: the hub's snapshot/event/result contract and the wire route that
 * exposes it (`GET /api/v2/live/:gameId`).
 *
 * These tests use no PostgreSQL and no match execution: the hub is fed by hand through the same
 * publisher handle the executor uses. The route half runs a real Fastify server on an ephemeral
 * port with real WebSocket clients, so the frozen wire shape (SNAPSHOT → EVENT → RESULT, close
 * 4404 for an unknown game) is exercised as the web client will see it.
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
import type { LeaseIdentity } from '@oantuti/protocol';
import type { Database } from '../src/persistence/db.js';
import { NativeLiveProjector } from '../src/live/native-live-projector.js';
import {
  LIVE_EVENT_BUFFER_LIMIT,
  LiveMatchHub,
  type LiveServerMessage,
  type LiveSend,
  type LiveTurnInput,
} from '../src/live/live-match-hub.js';
import { LIVE_MAX_BUFFERED_BYTES, registerLiveRoutes } from '../src/live/live-routes.js';

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
  startingPieces: [{ id: 1, owner: 'WHITE', type: 'ROCK', pos: [0, 1] }],
};

const WHITE_TEAM = { id: 'team-white', name: 'White Wolves' };
const BLACK_TEAM = { id: 'team-black', name: 'Black Bears' };
const IDENTITY = { attemptId: 'live-attempt', fencingToken: '12', deploymentGeneration: 3 };

/** Captures everything a hub sends to one subscriber. */
function recorder(): { readonly messages: LiveServerMessage[]; readonly send: LiveSend } {
  const messages: LiveServerMessage[] = [];
  return { messages, send: (message) => messages.push(message) };
}

function move(turnNumber: number, side: 1 | 2, pieceId: number, target: [number, number]): LiveTurnInput {
  return { turnNumber, side, action: { action: 'MOVE', pieceId, target } };
}

function openRequest(gameId: string) {
  return { gameId, map: MAP, whiteTeam: WHITE_TEAM, blackTeam: BLACK_TEAM, identity: IDENTITY };
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
  it('keeps preview termination distinct from durable accepted outcome and preserves reconnect identity', () => {
    const hub = new LiveMatchHub();
    const gameId = randomUUID();
    const publisher = hub.openGame(openRequest(gameId));
    publisher.publishTurn(move(1, 1, 1, [1, 1]));
    const spectator = recorder();
    hub.subscribe(gameId, spectator.send);
    publisher.previewEnd();
    publisher.publishTurn(move(2, 2, 2, [2, 2]));
    expect(spectator.messages).toHaveLength(2);
    expect(spectator.messages[1]).toEqual({ type: 'PREVIEW_ENDED', gameId, ...IDENTITY });
    const reconnect = recorder();
    hub.subscribe(gameId, reconnect.send);
    expect(reconnect.messages[0]).toMatchObject({ status: 'PREVIEW_ENDED', seq: 1, ...IDENTITY });
    expect(reconnect.messages[0]).not.toHaveProperty('result');
    hub.confirmAccepted(gameId, { winner: 2, reason: 'EXTINCTION' });
    expect(spectator.messages[2]).toEqual({ type: 'RESULT', gameId, ...IDENTITY, winner: 2, reason: 'EXTINCTION' });
    hub.dispose();
  });

  it('marks a truncated snapshot as incomplete instead of pretending it reconstructs the board', () => {
    const hub = new LiveMatchHub({ eventBufferLimit: 1 });
    const gameId = randomUUID();
    const publisher = hub.openGame(openRequest(gameId));
    publisher.publishTurn(move(1, 1, 1, [1, 1]));
    publisher.publishTurn(move(2, 2, 2, [2, 2]));
    const spectator = recorder();
    hub.subscribe(gameId, spectator.send);
    expect(spectator.messages[0]).toMatchObject({ seq: 2, historyComplete: false, events: [{ seq: 2 }] });
    hub.dispose();
  });
  it('gives a late joiner a snapshot carrying every event published before it subscribed', () => {
    const gameId = randomUUID();
    const hub = new LiveMatchHub();
    const live = hub.openGame(openRequest(gameId));
    live.publishTurn(move(1, 1, 3, [2, 3]));
    live.publishTurn({
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
      ...IDENTITY,
      seq: 2,
      historyComplete: true,
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
    live.publishTurn(move(3, 1, 3, [1, 1]));
    expect(spectator.messages[1]).toEqual({
      type: 'EVENT',
      gameId,
      ...IDENTITY,
      seq: 3,
      turnNumber: 3,
      side: 1,
      action: { action: 'MOVE', pieceId: 3, target: [1, 1] },
    });
  });

  it('delivers one published event to both subscribers', () => {
    const gameId = randomUUID();
    const hub = new LiveMatchHub();
    const live = hub.openGame(openRequest(gameId));

    const first = recorder();
    const second = recorder();
    expect(hub.subscribe(gameId, first.send)).not.toBeNull();
    expect(hub.subscribe(gameId, second.send)).not.toBeNull();

    live.publishTurn(move(1, 2, 9, [6, 6]));

    for (const spectator of [first, second]) {
      expect(spectator.messages).toHaveLength(2);
      expect(spectator.messages[1]).toEqual({
        type: 'EVENT',
        gameId,
        ...IDENTITY,
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
    const live = hub.openGame(openRequest(gameId));

    const leaving = recorder();
    const staying = recorder();
    const unsubscribe = hub.subscribe(gameId, leaving.send)!;
    hub.subscribe(gameId, staying.send);

    unsubscribe();
    unsubscribe();
    expect(hub.stats().subscribers).toBe(1);

    live.publishTurn(move(1, 1, 1, [1, 1]));
    expect(leaving.messages).toHaveLength(1); // snapshot only
    expect(staying.messages).toHaveLength(2);

    live.publishTurn({ turnNumber: 2, side: 2, action: { action: 'PASS' } });
    expect(leaving.messages).toHaveLength(1);
    expect(staying.messages[2]).toEqual({
      type: 'EVENT',
      gameId,
      ...IDENTITY,
      seq: 2,
      turnNumber: 2,
      side: 2,
      action: { action: 'PASS' },
    });
  });

  it('marks the game FINISHED, publishes RESULT once, and serves the result to a later joiner', () => {
    const gameId = randomUUID();
    const hub = new LiveMatchHub();
    const live = hub.openGame(openRequest(gameId));

    const spectator = recorder();
    hub.subscribe(gameId, spectator.send);
    live.publishTurn(move(1, 1, 1, [7, 7]));

    live.finishGame({ winner: 1, reason: 'THRONE_BREACH' });
    expect(spectator.messages[2]).toEqual({ type: 'RESULT', gameId, ...IDENTITY, winner: 1, reason: 'THRONE_BREACH' });

    // A finished game accepts nothing further, and a repeated finish emits no second frame.
    live.publishTurn(move(2, 2, 2, [0, 0]));
    live.finishGame({ winner: 2, reason: 'EXTINCTION' });
    expect(spectator.messages).toHaveLength(3);

    const late = recorder();
    expect(hub.subscribe(gameId, late.send)).not.toBeNull();
    expect(late.messages).toEqual([
      {
        type: 'SNAPSHOT',
        gameId,
        ...IDENTITY,
        seq: 1,
        historyComplete: true,
        status: 'FINISHED',
        map: MAP,
        whiteTeam: WHITE_TEAM,
        blackTeam: BLACK_TEAM,
        events: [{ seq: 1, turnNumber: 1, side: 1, action: { action: 'MOVE', pieceId: 1, target: [7, 7] } }],
        result: { winner: 1, reason: 'THRONE_BREACH' },
      },
    ]);
  });

  it('reports an unknown game for subscribe and keeps no channel for it', () => {
    const hub = new LiveMatchHub();
    const spectator = recorder();

    expect(hub.hasGame('no-such-game')).toBe(false);
    expect(hub.subscribe('no-such-game', spectator.send)).toBeNull();
    expect(spectator.messages).toHaveLength(0);
    expect(hub.stats()).toEqual({ games: 0, subscribers: 0 });

    // A handle from a disposed hub cannot resurrect its channel either.
    const gameId = randomUUID();
    const live = hub.openGame(openRequest(gameId));
    hub.dispose();
    live.publishTurn(move(1, 1, 1, [1, 1]));
    live.finishGame({ winner: 1, reason: 'THRONE_BREACH' });
    expect(hub.hasGame(gameId)).toBe(false);
    expect(hub.stats()).toEqual({ games: 0, subscribers: 0 });
  });

  it('bounds the late-join buffer to the newest events', () => {
    const gameId = randomUUID();
    const hub = new LiveMatchHub();
    const live = hub.openGame(openRequest(gameId));
    for (let turn = 1; turn <= LIVE_EVENT_BUFFER_LIMIT + 50; turn++) {
      live.publishTurn(move(turn, turn % 2 === 0 ? 2 : 1, 1, [1, 1]));
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
      const live = hub.openGame(openRequest(gameId));

      const spectator = recorder();
      const unsubscribe = hub.subscribe(gameId, spectator.send)!;
      live.finishGame({ winner: 2, reason: 'EXTINCTION' });
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
    const firstAttempt = hub.openGame(openRequest(gameId));

    const spectator = recorder();
    hub.subscribe(gameId, spectator.send);
    firstAttempt.publishTurn(move(1, 1, 1, [1, 1]));
    firstAttempt.finishGame({ winner: 1, reason: 'THRONE_BREACH' });

    const secondAttempt = hub.openGame({ ...openRequest(gameId), whiteTeam: { id: 'team-white', name: 'Renamed Wolves' } });

    expect(spectator.messages[3]).toEqual({
      type: 'SNAPSHOT',
      gameId,
      ...IDENTITY,
      seq: 0,
      historyComplete: true,
      status: 'RUNNING',
      map: MAP,
      whiteTeam: { id: 'team-white', name: 'Renamed Wolves' },
      blackTeam: BLACK_TEAM,
      events: [],
    });
    secondAttempt.publishTurn(move(1, 2, 2, [2, 2]));
    expect(spectator.messages[4]).toMatchObject({ type: 'EVENT', turnNumber: 1, side: 2 });
  });

  it('accepts nothing from the attempt that lost the game to a requeue', () => {
    const gameId = randomUUID();
    const hub = new LiveMatchHub();
    const stale = hub.openGame(openRequest(gameId));

    const spectator = recorder();
    hub.subscribe(gameId, spectator.send);
    stale.publishTurn(move(1, 1, 1, [1, 1]));

    // The lease expired and the game was requeued: the new attempt owns the channel.
    const current = hub.openGame(openRequest(gameId));
    const snapshotsAfterReopen = spectator.messages.filter((message) => message.type === 'SNAPSHOT').length;

    // Everything the stale attempt still emits is ignored: no ply, no result, no closure.
    stale.publishTurn(move(2, 2, 2, [2, 2]));
    stale.finishGame({ winner: 1, reason: 'THRONE_BREACH' });
    expect(spectator.messages.filter((message) => message.type === 'EVENT')).toHaveLength(1);
    expect(spectator.messages.filter((message) => message.type === 'RESULT')).toHaveLength(0);
    expect(spectator.messages.filter((message) => message.type === 'SNAPSHOT')).toHaveLength(snapshotsAfterReopen);

    // The channel is still open and still belongs to the current attempt.
    current.publishTurn(move(1, 1, 9, [3, 3]));
    const events = spectator.messages.filter((message) => message.type === 'EVENT');
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ seq: 1, turnNumber: 1, side: 1, action: { action: 'MOVE', pieceId: 9, target: [3, 3] } });

    current.finishGame({ winner: 2, reason: 'EXTINCTION' });
    const results = spectator.messages.filter((message) => message.type === 'RESULT');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ winner: 2, reason: 'EXTINCTION' });
  });
});

describe('NativeLiveProjector', () => {
  const lease: LeaseIdentity = { jobId: randomUUID(), attemptId: randomUUID(), grantId: randomUUID(), fencingToken: '9', deploymentGeneration: 4 };

  it('refuses private/nonofficial targets before creating any public channel', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Database;
    const hub = new LiveMatchHub();
    const projector = new NativeLiveProjector(db, hub);
    await expect(projector.open(lease, randomUUID(), MAP)).rejects.toThrow('official GAME');
    expect(hub.stats()).toEqual({ games: 0, subscribers: 0 });
    expect(() => projector.turn(lease, { seq: 1, turnNumber: 1, side: 1, action: { action: 'PASS' } })).toThrow();
  });

  it('rejects stale fences and sequence gaps, deduplicates retries, and never scores a preview', async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ white_team_id: 'white', black_team_id: 'black', white_name: 'White', black_name: 'Black' }] }) } as unknown as Database;
    const hub = new LiveMatchHub();
    const projector = new NativeLiveProjector(db, hub);
    const gameId = randomUUID();
    await projector.open(lease, gameId, MAP);
    const spectator = recorder();
    hub.subscribe(gameId, spectator.send);
    const turn = { seq: 1, turnNumber: 1, side: 1, action: { action: 'PASS' } };
    expect(() => projector.turn({ ...lease, fencingToken: '8' }, turn)).toThrow('stale');
    expect(() => projector.turn(lease, { ...turn, seq: 2 })).toThrow('gap');
    projector.turn(lease, turn);
    projector.turn(lease, turn);
    expect(spectator.messages).toHaveLength(2);
    expect(spectator.messages[1]).toMatchObject({ type: 'EVENT', seq: 1, attemptId: lease.attemptId, fencingToken: '9', deploymentGeneration: 4 });
    projector.previewEnd(lease);
    expect(spectator.messages[2]).toMatchObject({ type: 'PREVIEW_ENDED' });
    expect(spectator.messages.some((message) => message.type === 'RESULT')).toBe(false);
    projector.accepted(gameId, { winner: 2, reason: 'EXTINCTION' });
    expect(spectator.messages[3]).toMatchObject({ type: 'RESULT', winner: 2 });
    hub.dispose();
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
    const live = hub.openGame(openRequest(gameId));
    live.publishTurn(move(1, 1, 4, [3, 3]));

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
    live.publishTurn(move(2, 2, 7, [5, 5]));
    const [eventRaw] = await eventFrame;
    expect(parseFrame(eventRaw)).toEqual({
      type: 'EVENT',
      gameId,
      ...IDENTITY,
      seq: 2,
      turnNumber: 2,
      side: 2,
      action: { action: 'MOVE', pieceId: 7, target: [5, 5] },
    });

    const resultFrame = once(socket, 'message');
    live.finishGame({ winner: 2, reason: 'EXTINCTION' });
    const [resultRaw] = await resultFrame;
    expect(parseFrame(resultRaw)).toEqual({ type: 'RESULT', gameId, ...IDENTITY, winner: 2, reason: 'EXTINCTION' });

    const [closeCode] = await closed;
    expect(closeCode).toBe(1000);
  });

  it('serves a finished game to a late joiner and closes right after the snapshot', async () => {
    const gameId = randomUUID();
    const live = hub.openGame(openRequest(gameId));
    live.publishTurn(move(1, 1, 4, [3, 3]));
    live.finishGame({ winner: 1, reason: 'THRONE_BREACH' });

    const socket = new WebSocket(`ws://${origin}/api/v2/live/${gameId}`);
    socket.on('error', () => undefined);
    const snapshotFrame = once(socket, 'message');
    const closed = once(socket, 'close');

    const [snapshotRaw] = await snapshotFrame;
    expect(parseFrame(snapshotRaw)).toEqual({
      type: 'SNAPSHOT',
      gameId,
      ...IDENTITY,
      seq: 1,
      historyComplete: true,
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

  it('keeps a preview-ended socket open until an accepted official outcome arrives', async () => {
    const gameId = randomUUID();
    const publisher = hub.openGame(openRequest(gameId));
    const socket = new WebSocket(`ws://${origin}/api/v2/live/${gameId}`);
    await once(socket, 'message');
    const terminalPreview = once(socket, 'message');
    publisher.previewEnd();
    expect(parseFrame((await terminalPreview)[0])).toMatchObject({ type: 'PREVIEW_ENDED', ...IDENTITY });
    expect(socket.readyState).toBe(WebSocket.OPEN);
    const result = once(socket, 'message');
    const closed = once(socket, 'close');
    hub.confirmAccepted(gameId, { winner: 1, reason: 'THRONE_BREACH' });
    expect(parseFrame((await result)[0])).toMatchObject({ type: 'RESULT', winner: 1 });
    expect((await closed)[0]).toBe(1000);
    await waitFor(() => hub.stats().subscribers === 0);
  });

  it('disconnects a slow spectator before sending beyond the one MiB queue cap', async () => {
    const gameId = randomUUID();
    const publisher = hub.openGame(openRequest(gameId));
    const socket = new WebSocket(`ws://${origin}/api/v2/live/${gameId}`);
    await once(socket, 'message');
    const serverSocket = [...app.websocketServer.clients].find((client) => client.readyState === WebSocket.OPEN)!;
    const buffered = vi.spyOn(serverSocket, 'bufferedAmount', 'get').mockReturnValue(LIVE_MAX_BUFFERED_BYTES);
    const closed = once(socket, 'close');
    publisher.publishTurn(move(1, 1, 1, [1, 1]));
    expect((await closed)[0]).toBe(4405);
    buffered.mockRestore();
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
