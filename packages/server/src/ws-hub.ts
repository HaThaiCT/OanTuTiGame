/**
 * Binary WebSocket Streaming Hub for OanTuTi Arena
 * Adheres strictly to docs/specs/03-NETWORK-PROTOCOL-SPEC.md Section 2 & 5.
 * Handles client subscriptions, catch-up invariant, and real-time broadcasting.
 */

import { WebSocket } from 'ws';
import {
  decodeWebSocketFrame,
  encodeWebSocketFrame,
  unpackReplay,
  encodeMatchInitFrame,
  encodeTurnDeltaFrame,
  encodeMatchEndFrame,
  WebSocketMessageType,
} from '@oantuti/protocol';
import { MatchService } from './match-service.js';
import { Database } from './db.js';

export class WebSocketHub {
  private readonly matchService: MatchService;
  private readonly db: Database;
  private readonly subscribers = new Map<string, Set<WebSocket>>();

  constructor(matchService: MatchService, db: Database) {
    this.matchService = matchService;
    this.db = db;

    // Listen to live events from MatchService
    this.matchService.on('match:delta', ({ matchId, frame }) => {
      this.broadcastToMatch(matchId, frame);
    });

    this.matchService.on('match:end', ({ matchId, frame }) => {
      this.broadcastToMatch(matchId, frame);
    });
  }

  handleConnection(socket: WebSocket, matchId: string): void {
    const activeMatch = this.matchService.getActiveMatch(matchId);

    if (activeMatch) {
      // 1. Send Init Frame (Catch-up phase 1)
      this.sendBinary(socket, activeMatch.initFrameBytes);

      // 2. Send accumulated delta frames (Catch-up phase 2)
      for (const deltaFrame of activeMatch.deltaFrameBytes) {
        this.sendBinary(socket, deltaFrame);
      }

      // 3. If already ended, send End Frame
      if (activeMatch.isFinished && activeMatch.endFrameBytes) {
        this.sendBinary(socket, activeMatch.endFrameBytes);
        return;
      }

      // 4. Register subscriber for future live frames
      this.addSubscriber(matchId, socket);
    } else {
      // Check if match was completed and replay exists in database
      const replayRow = this.db.getReplayByMatchId(matchId);
      if (replayRow && replayRow.replay_data) {
        try {
          const { init, deltas, end } = unpackReplay(replayRow.replay_data);
          const initBytes = encodeWebSocketFrame(
            WebSocketMessageType.MSG_INIT,
            encodeMatchInitFrame(init)
          );
          this.sendBinary(socket, initBytes);

          for (const delta of deltas) {
            const deltaBytes = encodeWebSocketFrame(
              WebSocketMessageType.MSG_DELTA,
              encodeTurnDeltaFrame(delta)
            );
            this.sendBinary(socket, deltaBytes);
          }

          const endBytes = encodeWebSocketFrame(
            WebSocketMessageType.MSG_END,
            encodeMatchEndFrame(end)
          );
          this.sendBinary(socket, endBytes);
        } catch {
          this.sendError(socket, `Corrupted replay for match ${matchId}`);
        }
      } else {
        this.sendError(socket, `Match "${matchId}" not found`);
        socket.close(1008, 'Match not found');
        return;
      }
    }

    // Handle incoming client messages (Ping / Pong)
    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      try {
        const buffer = data instanceof Buffer ? new Uint8Array(data) : new Uint8Array(data as ArrayBuffer);
        if (buffer.length >= 5) {
          const { type, payload } = decodeWebSocketFrame(buffer);
          if (type === WebSocketMessageType.MSG_PING) {
            const pongFrame = encodeWebSocketFrame(WebSocketMessageType.MSG_PONG, payload);
            this.sendBinary(socket, pongFrame);
          }
        }
      } catch {
        // Ignore malformed client ping
      }
    });

    socket.on('close', () => {
      this.removeSubscriber(matchId, socket);
    });

    socket.on('error', () => {
      this.removeSubscriber(matchId, socket);
    });
  }

  private addSubscriber(matchId: string, socket: WebSocket): void {
    let set = this.subscribers.get(matchId);
    if (!set) {
      set = new Set<WebSocket>();
      this.subscribers.set(matchId, set);
    }
    set.add(socket);
  }

  private removeSubscriber(matchId: string, socket: WebSocket): void {
    const set = this.subscribers.get(matchId);
    if (set) {
      set.delete(socket);
      if (set.size === 0) {
        this.subscribers.delete(matchId);
      }
    }
  }

  private broadcastToMatch(matchId: string, frame: Uint8Array): void {
    const clients = this.subscribers.get(matchId);
    if (!clients || clients.size === 0) return;

    for (const client of clients) {
      this.sendBinary(client, frame);
    }
  }

  private sendBinary(socket: WebSocket, data: Uint8Array): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(data, { binary: true });
    }
  }

  private sendError(socket: WebSocket, message: string): void {
    if (socket.readyState === WebSocket.OPEN) {
      const payload = new TextEncoder().encode(message);
      const frame = encodeWebSocketFrame(WebSocketMessageType.MSG_ERROR, payload);
      this.sendBinary(socket, frame);
    }
  }

  getSubscriberCount(matchId: string): number {
    return this.subscribers.get(matchId)?.size ?? 0;
  }
}
