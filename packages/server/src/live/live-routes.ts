/**
 * Public live-spectator route for official games: `GET /api/v2/live/:gameId`.
 *
 * Spectating is anonymous (no cookie, no CSRF surface — the route is a read-only GET). The
 * socket receives a SNAPSHOT immediately, then one EVENT per ply, then RESULT, after which the
 * server closes. An unknown game id (never opened, or already past the hub's retention window)
 * closes with 4404.
 *
 * Registered with `wsHandler` rather than `websocket: true` on purpose: `websocket: true` would
 * replace the HTTP handler with an empty 404, while browsers and curl pointed at a live game
 * should get a JSON answer (426 Upgrade Required) instead.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { WebSocket } from 'ws';
import type { LiveMatchHub, LiveSend } from './live-match-hub.js';

/** RFC 6455 application close codes (private range) used by this route. */
const CLOSE_GAME_NOT_FOUND = 4404;
const CLOSE_STALE = 4408;
const CLOSE_SPECTATOR_CAPACITY = 4405;
const CLOSE_NORMAL = 1000;
/** Liveness: ping every 20 s; close a spectator whose pongs have been missing for 60 s. */
const HEARTBEAT_INTERVAL_MS = 20_000;
const STALE_TIMEOUT_MS = 60_000;

export function registerLiveRoutes(app: FastifyInstance, hub: LiveMatchHub): void {
  app.route<{ Params: { gameId: string } }>({
    method: 'GET',
    url: '/api/v2/live/:gameId',
    wsHandler: (socket, request) => {
      handleSpectator(socket, request.params.gameId, hub);
    },
    handler: async (request: FastifyRequest<{ Params: { gameId: string } }>, reply: FastifyReply) => {
      const { gameId } = request.params;
      if (!hub.hasGame(gameId)) return reply.code(404).send({ error: 'GAME_NOT_FOUND' });
      return reply.code(426).send({ error: 'WEBSOCKET_UPGRADE_REQUIRED', gameId });
    },
  });
}

function handleSpectator(socket: WebSocket, gameId: string, hub: LiveMatchHub): void {
  if (!hub.hasGame(gameId)) {
    socket.close(CLOSE_GAME_NOT_FOUND, 'GAME_NOT_FOUND');
    return;
  }

  const send: LiveSend = (message) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(message));
    // The contract ends a stream with RESULT: a late joiner gets it inside the snapshot, a live
    // one as the last frame, and the socket is closed either way.
    if (message.type === 'RESULT' || (message.type === 'SNAPSHOT' && message.status === 'FINISHED')) {
      socket.close(CLOSE_NORMAL, 'GAME_FINISHED');
    }
  };

  const unsubscribe = hub.subscribe(gameId, send);
  if (!unsubscribe) {
    socket.close(CLOSE_SPECTATOR_CAPACITY, 'SPECTATOR_CAPACITY');
    return;
  }

  // 'error' as well as 'close': a spectator that vanishes mid-game must leave the hub at once,
  // not at the retention deadline.
  let lastSeen = Date.now();
  socket.on('pong', () => {
    lastSeen = Date.now();
  });
  const heartbeat = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastSeen > STALE_TIMEOUT_MS) {
      socket.close(CLOSE_STALE, 'STALE');
      return;
    }
    socket.ping();
    // App-level ping as well: it keeps every client stack honest even if it never surfaces
    // protocol-level pongs to the page.
    send({ type: 'PING', at: new Date().toISOString() });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
}
