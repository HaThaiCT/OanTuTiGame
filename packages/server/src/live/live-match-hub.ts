/**
 * Live spectator fan-out for official tournament games.
 *
 * One channel per running game. The match executor opens it once both bots are ready to play
 * and closes it with the match outcome; a finished channel is retained for a grace period so a
 * late joiner still receives the whole game as a snapshot. After that grace period the channel
 * (and its buffer) is dropped, so the hub's memory follows the games that are actually being
 * watched or just finished — never the whole tournament history.
 *
 * Delivery is best-effort by design: this hub is a read-only projection of the executor's turn
 * stream (`onTurn`) and never gates match execution. A subscriber whose `send` throws, or a
 * spectator that vanishes mid-game, cannot slow down, fail or leak a game.
 *
 * Wire contract (frozen for the web client):
 *   SNAPSHOT  sent immediately on subscribe: game metadata, status, every buffered event so far
 *   EVENT     one per ply, in order, exactly as the executor produced it
 *   RESULT    sent once when the game finishes; the route closes the socket after it
 */

import type { MapDescriptor } from '@oantuti/engine';

/** Side numbering used on the wire: 1 = white, 2 = black. */
export type LiveSide = 1 | 2;

export type LiveAction =
  | { readonly action: 'MOVE'; readonly pieceId: number; readonly target: readonly [number, number] }
  | { readonly action: 'PASS' };

/** One ply as spectators see it; `capture` is the engine's capture record when one happened. */
export interface LiveTurnEvent {
  /** 1-based monotonic sequence per game; a gap tells the client to resubscribe for a snapshot. */
  readonly seq: number;
  readonly turnNumber: number;
  readonly side: LiveSide;
  readonly action: LiveAction;
  readonly capture?: unknown;
}

/** What the executor hands the hub; the hub owns sequence numbering. */
export type LiveTurnInput = Omit<LiveTurnEvent, 'seq'>;

export interface LiveTeamRef {
  readonly id: string;
  readonly name: string;
}

export interface LiveResult {
  readonly winner: LiveSide | null;
  readonly reason: string;
}

export interface LiveSnapshot {
  readonly type: 'SNAPSHOT';
  readonly gameId: string;
  readonly status: 'RUNNING' | 'FINISHED';
  readonly map: MapDescriptor;
  readonly whiteTeam: LiveTeamRef;
  readonly blackTeam: LiveTeamRef;
  /** Buffered plies, oldest first, capped at {@link LIVE_EVENT_BUFFER_LIMIT}. */
  readonly events: readonly LiveTurnEvent[];
  readonly result?: LiveResult;
}

export interface LiveEventMessage extends LiveTurnEvent {
  readonly type: 'EVENT';
  readonly gameId: string;
}

export interface LiveResultMessage extends LiveResult {
  readonly type: 'RESULT';
  readonly gameId: string;
}

export interface LivePingMessage {
  readonly type: 'PING';
  readonly at: string;
}

export type LiveServerMessage = LiveSnapshot | LiveEventMessage | LiveResultMessage | LivePingMessage;

/** Sink of one spectator connection; the route turns messages into JSON frames. */
export type LiveSend = (message: LiveServerMessage) => void;

/** Detaches the subscriber; idempotent, so a route can call it from every teardown path. */
export type LiveUnsubscribe = () => void;

/** Plies kept per game for late joiners; covers the full 300-turn match budget. */
export const LIVE_EVENT_BUFFER_LIMIT = 400;
/** How long a finished game stays subscribable so late joiners still get the result. */
export const LIVE_FINISHED_RETENTION_MS = 5 * 60 * 1_000;
/** Per-game and process-wide spectator ceilings; a third spectator beyond them is refused. */
export const LIVE_MAX_SUBSCRIBERS_PER_GAME = 256;
export const LIVE_MAX_SUBSCRIBERS_TOTAL = 4_096;

export interface LiveMatchHubOptions {
  readonly eventBufferLimit?: number;
  readonly finishedRetentionMs?: number;
  readonly maxSubscribersPerGame?: number;
  readonly maxSubscribersTotal?: number;
}

export interface OpenLiveGameRequest {
  readonly gameId: string;
  readonly map: MapDescriptor;
  readonly whiteTeam: LiveTeamRef;
  readonly blackTeam: LiveTeamRef;
}

interface LiveChannel {
  gameId: string;
  map: MapDescriptor;
  whiteTeam: LiveTeamRef;
  blackTeam: LiveTeamRef;
  status: 'RUNNING' | 'FINISHED';
  events: LiveTurnEvent[];
  result?: LiveResult;
  readonly subscribers: Set<LiveSend>;
  /** Retention timer of a finished game; unref'd so it never holds the process open. */
  expiry?: NodeJS.Timeout;
}

export class LiveMatchHub {
  private readonly channels = new Map<string, LiveChannel>();
  private readonly eventBufferLimit: number;
  private readonly finishedRetentionMs: number;
  private readonly maxSubscribersPerGame: number;
  private readonly maxSubscribersTotal: number;
  private subscriberCount = 0;

  constructor(options: LiveMatchHubOptions = {}) {
    this.eventBufferLimit = options.eventBufferLimit ?? LIVE_EVENT_BUFFER_LIMIT;
    this.finishedRetentionMs = options.finishedRetentionMs ?? LIVE_FINISHED_RETENTION_MS;
    this.maxSubscribersPerGame = options.maxSubscribersPerGame ?? LIVE_MAX_SUBSCRIBERS_PER_GAME;
    this.maxSubscribersTotal = options.maxSubscribersTotal ?? LIVE_MAX_SUBSCRIBERS_TOTAL;
  }

  /**
   * Starts (or restarts) the live channel of a game. Re-opening a game that already has a
   * channel — a faulted attempt whose lease expired and was requeued — keeps its subscribers
   * and re-syncs them with a fresh, empty snapshot instead of dropping them.
   */
  openGame(request: OpenLiveGameRequest): void {
    const existing = this.channels.get(request.gameId);
    if (!existing) {
      this.channels.set(request.gameId, {
        gameId: request.gameId,
        map: request.map,
        whiteTeam: request.whiteTeam,
        blackTeam: request.blackTeam,
        status: 'RUNNING',
        events: [],
        subscribers: new Set<LiveSend>(),
      });
      return;
    }

    this.clearExpiry(existing);
    existing.map = request.map;
    existing.whiteTeam = request.whiteTeam;
    existing.blackTeam = request.blackTeam;
    existing.status = 'RUNNING';
    existing.events = [];
    delete existing.result;

    // Subscribers attached to the previous attempt restart from a clean snapshot: their ply
    // numbering would otherwise continue into a match that was never played.
    const snapshot = this.snapshot(existing);
    for (const send of existing.subscribers) this.safeSend(send, snapshot);
  }

  /** Appends one ply and pushes it to every spectator; a no-op once the game is finished. */
  publishTurn(gameId: string, event: LiveTurnInput): void {
    const channel = this.channels.get(gameId);
    if (!channel || channel.status === 'FINISHED') return;

    const last = channel.events[channel.events.length - 1];
    const sequenced: LiveTurnEvent = { ...event, seq: last ? last.seq + 1 : 1 };
    channel.events.push(sequenced);
    if (channel.events.length > this.eventBufferLimit) {
      channel.events.splice(0, channel.events.length - this.eventBufferLimit);
    }

    const message: LiveEventMessage = { type: 'EVENT', gameId, ...sequenced };
    for (const send of channel.subscribers) this.safeSend(send, message);
  }

  /**
   * Marks the game FINISHED, publishes RESULT once and starts the retention countdown.
   * Idempotent: a second call for the same game only restarts the countdown, so a duplicated
   * teardown path can never emit two results.
   */
  finishGame(gameId: string, result: LiveResult): void {
    const channel = this.channels.get(gameId);
    if (!channel) return;

    if (channel.status === 'RUNNING') {
      channel.status = 'FINISHED';
      channel.result = result;
      const message: LiveResultMessage = {
        type: 'RESULT',
        gameId,
        winner: result.winner,
        reason: result.reason,
      };
      for (const send of channel.subscribers) this.safeSend(send, message);
    }

    this.scheduleExpiry(channel);
  }

  /**
   * Attaches a spectator: it receives the SNAPSHOT immediately and every later ply. The snapshot
   * is built and sent synchronously, so a ply can never be delivered twice or skipped across a
   * subscribe.
   *
   * Returns `null` when the hub has no channel for the game (caller answers 4404) or when the
   * subscriber ceilings are reached (caller answers with a capacity close).
   */
  subscribe(gameId: string, send: LiveSend): LiveUnsubscribe | null {
    const channel = this.channels.get(gameId);
    if (!channel) return null;
    if (
      channel.subscribers.size >= this.maxSubscribersPerGame ||
      this.subscriberCount >= this.maxSubscribersTotal
    ) {
      return null;
    }

    channel.subscribers.add(send);
    this.subscriberCount++;
    this.safeSend(send, this.snapshot(channel));

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      // Only a subscriber still registered in the channel counts towards the budget: one whose
      // channel was already dropped must not decrement it a second time.
      if (channel.subscribers.delete(send)) this.subscriberCount--;
    };
  }

  /** True while the game is live or still inside its post-finish retention window. */
  hasGame(gameId: string): boolean {
    return this.channels.has(gameId);
  }

  /** Channel/subscriber counters, for operator surfaces and tests. */
  stats(): { readonly games: number; readonly subscribers: number } {
    return { games: this.channels.size, subscribers: this.subscriberCount };
  }

  /** Drops every channel and pending retention timer (server shutdown, tests). */
  dispose(): void {
    for (const channel of this.channels.values()) this.clearExpiry(channel);
    this.channels.clear();
    this.subscriberCount = 0;
  }

  private snapshot(channel: LiveChannel): LiveSnapshot {
    return {
      type: 'SNAPSHOT',
      gameId: channel.gameId,
      status: channel.status,
      map: channel.map,
      whiteTeam: channel.whiteTeam,
      blackTeam: channel.blackTeam,
      events: [...channel.events],
      ...(channel.result ? { result: channel.result } : {}),
    };
  }

  private scheduleExpiry(channel: LiveChannel): void {
    this.clearExpiry(channel);
    const timer = setTimeout(() => this.drop(channel.gameId), this.finishedRetentionMs);
    // A retained finished game must never keep the process alive on its own.
    timer.unref();
    channel.expiry = timer;
  }

  private clearExpiry(channel: LiveChannel): void {
    if (channel.expiry) {
      clearTimeout(channel.expiry);
      channel.expiry = undefined;
    }
  }

  private drop(gameId: string): void {
    const channel = this.channels.get(gameId);
    if (!channel) return;
    this.channels.delete(gameId);
    this.clearExpiry(channel);
    this.subscriberCount -= channel.subscribers.size;
    channel.subscribers.clear();
  }

  private safeSend(send: LiveSend, message: LiveServerMessage): void {
    try {
      send(message);
    } catch {
      // A spectator sink that throws must never break the game or another spectator.
    }
  }
}
