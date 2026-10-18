import { createHash, randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import {
  applyMoveV2, createInitialGameState, createMapTopology, evaluateVictoryV2,
  isLegalMove, pieceTypeToString, playerSideToString, PlayerSide,
  type GameState, type MapDescriptor,
} from '@oantuti/engine';
import { Envelope, Side, ExecutionFault_Kind, type RunBotTurn } from '@oantuti/protocol';

const MAX_FRAME = 1024 * 1024;

class BotFault extends Error {
  constructor(readonly side: Side, readonly reason: 'PROTOCOL_VIOLATION' | 'ILLEGAL_MOVE' | 'OUTPUT_LIMIT') {
    super(reason);
  }
}

async function* frames(socket: Duplex): AsyncGenerator<Envelope> {
  const header = Buffer.alloc(4);
  let headerUsed = 0;
  let body: Buffer | undefined;
  let bodyUsed = 0;
  for await (const input of socket) {
    const chunk: Buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
    let offset = 0;
    while (offset < chunk.length) {
      if (!body) {
        const count = Math.min(4 - headerUsed, chunk.length - offset);
        chunk.copy(header, headerUsed, offset, offset + count);
        headerUsed += count;
        offset += count;
        if (headerUsed !== 4) continue;
        const size = header.readUInt32BE();
        if (!size || size > MAX_FRAME) throw new Error('EXECUTION_FRAME_LIMIT');
        body = Buffer.alloc(size);
      }
      const count = Math.min(body.length - bodyUsed, chunk.length - offset);
      chunk.copy(body, bodyUsed, offset, offset + count);
      bodyUsed += count;
      offset += count;
      if (bodyUsed === body.length) {
        const decoded = Envelope.decode(body);
        body = undefined;
        bodyUsed = headerUsed = 0;
        yield decoded;
      }
    }
  }
  if (headerUsed || body) throw new Error('EXECUTION_TRUNCATED_FRAME');
}

function pieces(state: GameState) {
  return Array.from(state.pieces.values(), piece => ({
    id: piece.id, owner: playerSideToString(piece.owner), type: pieceTypeToString(piece.type),
    x: piece.pos.x, y: piece.pos.y, is_alive: piece.isAlive,
  }));
}

/** Trusted engine endpoint. The caller supplies a private supervisor socket;
 * this process never launches Bot code or possesses launcher/cgroup authority.
 * Engine semantics currently match the existing engine, not certified v2 rules.
 */
export async function runGameHost(socket: Duplex): Promise<void> {
  const input = frames(socket)[Symbol.asyncIterator]();
  let outgoing = 0n;
  let incoming = 0n;
  let binding: Envelope | undefined;
  async function receive(): Promise<Envelope> {
    const next = await input.next();
    if (next.done) throw new Error('SUPERVISOR_DISCONNECTED');
    const value = next.value;
    if (value.protocolVersion !== 2 || value.sequence !== String(incoming++)) throw new Error('EXECUTION_SEQUENCE');
    if (binding && (value.gameId !== binding.gameId || value.attemptId !== binding.attemptId
      || !Buffer.from(value.manifestSha256).equals(binding.manifestSha256))) throw new Error('EXECUTION_BINDING');
    if (value.message?.$case === 'stopGame') throw new Error('EXECUTION_STOPPED');
    return value;
  }
  async function send(message: NonNullable<Envelope['message']>, requestId = randomUUID()) {
    if (!binding) throw new Error('EXECUTION_NOT_STARTED');
    const bytes = Envelope.encode(Envelope.create({
      protocolVersion: 2, gameId: binding.gameId, attemptId: binding.attemptId,
      manifestSha256: binding.manifestSha256, sequence: String(outgoing++), requestId, message,
    })).finish();
    if (!bytes.length || bytes.length > MAX_FRAME) throw new Error('EXECUTION_FRAME_LIMIT');
    const frame = Buffer.allocUnsafe(4 + bytes.length);
    frame.writeUInt32BE(bytes.length);
    frame.set(bytes, 4);
    await new Promise<void>((resolve, reject) => socket.write(frame, error => error ? reject(error) : resolve()));
  }
  try {
    binding = await receive();
    if (binding.message?.$case !== 'startGame' || binding.manifestSha256.length !== 32) throw new Error('EXECUTION_START_REQUIRED');
    const manifestBytes = binding.message.startGame.canonicalGameManifest;
    if (!createHash('sha256').update(manifestBytes).digest().equals(binding.manifestSha256)) throw new Error('MANIFEST_DIGEST');
    const manifest: { map: MapDescriptor; maxTurns: number } = JSON.parse(Buffer.from(manifestBytes).toString('utf8'));
    if (!Number.isInteger(manifest.maxTurns) || manifest.maxTurns < 1 || manifest.maxTurns > 300) throw new Error('INVALID_MAX_PLY');
    let state = createInitialGameState(createMapTopology(manifest.map), manifest.map.startingPieces, manifest.maxTurns);
    const trace: unknown[] = [];
    async function request(side: Side, ply: number, payload: object): Promise<unknown> {
      const requestId = randomUUID();
      const requestNdjson = Buffer.from(JSON.stringify(payload) + '\n');
      if (requestNdjson.length > 256 * 1024) throw new Error('BOT_REQUEST_LIMIT');
      const command: RunBotTurn = { side, ply, requestNdjson };
      await send({ $case: 'runBotTurn', runBotTurn: command }, requestId);
      const response = await receive();
      if (response.requestId !== requestId) throw new Error('UNEXPECTED_OBSERVATION');
      if (response.message?.$case === 'executionFault') {
        const fault = response.message.executionFault;
        if (fault.side !== side) throw new Error('EXECUTION_FAULT_BINDING');
        if (fault.kind === ExecutionFault_Kind.PROTOCOL_ERROR) throw new BotFault(side, 'PROTOCOL_VIOLATION');
        if (fault.kind === ExecutionFault_Kind.OUTPUT_LIMIT) throw new BotFault(side, 'OUTPUT_LIMIT');
        throw new Error('UNRESOLVED_EXECUTION_INFRA');
      }
      if (response.requestId !== requestId || response.message?.$case !== 'turnObservation') throw new Error('UNEXPECTED_OBSERVATION');
      const observed = response.message.turnObservation;
      if (observed.side !== side || observed.ply !== ply || !observed.freezeConfirmed) throw new Error('UNCONFIRMED_OBSERVATION');
      const cpu = BigInt(observed.cpuUsageUsec);
      const wall = BigInt(observed.wallElapsedUsec);
      if (cpu < 0n || wall < 0n) throw new Error('INVALID_RESOURCE_COUNTER');
      if (cpu > (ply === 0 ? 500000n : 100000n) || wall >= 1000000n) throw new Error('OBSERVATION_OVER_BUDGET');
      const raw = Buffer.from(observed.responseNdjson);
      if (raw.length > 16384 || raw.at(-1) !== 10 || raw.subarray(0, -1).includes(10)) throw new BotFault(side, 'PROTOCOL_VIOLATION');
      try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
      } catch {
        throw new BotFault(side, 'PROTOCOL_VIOLATION');
      }
    }
    let outcome = evaluateVictoryV2(state);
    if (outcome.isGameOver) state = { ...state, isGameOver: true, winner: outcome.winner };
    let botFault: BotFault | undefined;
    try {
    if (!state.isGameOver) {
      for (const side of [Side.WHITE, Side.BLACK]) {
        const ready = await request(side, 0, {
          type: 'INIT', match_id: binding.gameId, my_side: Side[side],
          map: { name: manifest.map.mapName, width: manifest.map.width, height: manifest.map.height,
            valid_tiles: manifest.map.validTiles, white_throne: manifest.map.whiteThrone, black_throne: manifest.map.blackThrone },
          pieces: pieces(state), turn_time_limit_ms: 100, max_turns: manifest.maxTurns,
        }) as { status?: unknown };
        if (ready?.status !== 'READY') throw new BotFault(side, 'PROTOCOL_VIOLATION');
      }
    }
    while (!state.isGameOver) {
      const side = state.activePlayer as number as Side;
      const action = await request(side, state.turnNumber, {
        type: 'TURN', turn_number: state.turnNumber, time_remaining_ms: 100, pieces: pieces(state),
      }) as { action?: unknown; piece_id?: unknown; target?: unknown };
      if (action?.action !== 'MOVE' || !Number.isInteger(action.piece_id)
        || !Array.isArray(action.target) || action.target.length !== 2 || !action.target.every(Number.isInteger)) {
        throw new BotFault(side, action?.action === 'PASS' ? 'ILLEGAL_MOVE' : 'PROTOCOL_VIOLATION');
      }
      const move = { pieceId: action.piece_id as number, targetPos: { x: action.target[0], y: action.target[1] } };
      if (!isLegalMove(state, move, state.activePlayer)) throw new BotFault(side, 'ILLEGAL_MOVE');
      const ply = state.turnNumber;
      const delta = applyMoveV2(state, move);
      trace.push({ ply, side, move, capture: delta.capture });
      outcome = delta.outcome;
      state = { ...delta.nextState, isGameOver: outcome.isGameOver, winner: outcome.winner };
      const stateSha256 = createHash('sha256').update(JSON.stringify({ ply: state.turnNumber, pieces: pieces(state) })).digest();
      await send({ $case: 'turnCommitted', turnCommitted: { ply, stateSha256 } });
    }
    } catch (error) {
      if (!(error instanceof BotFault)) throw error;
      botFault = error;
      state = { ...state, isGameOver: true, winner: error.side === Side.WHITE ? PlayerSide.BLACK : PlayerSide.WHITE };
    }
    await send({ $case: 'gameFinished', gameFinished: { canonicalGameEvidence: Buffer.from(JSON.stringify({
      gameId: binding.gameId, winner: state.winner ?? PlayerSide.PLAYER_UNSPECIFIED,
      reason: botFault?.reason ?? outcome.reason, disposition: botFault ? 'DECISIVE' : outcome.disposition,
      executionStatus: botFault ? 'BOT_FORFEIT' : 'COMPLETED', rulesRevision: 'ArenaGameplay/v2', totalPly: trace.length, trace,
    })) } });
    socket.end();
  } catch (error) {
    socket.destroy();
    throw error;
  }
}
