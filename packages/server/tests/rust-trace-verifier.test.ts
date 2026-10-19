import { describe, expect, it } from 'vitest';
import { TraceVerifier } from '../src/results/trace-verifier.js';
import type { MapDescriptor } from '@oantuti/engine';
import type { AuthenticatedNativeExecution } from '../src/jobs/local-transport.js';
import type { GameResultEvidence } from '@oantuti/protocol';

// Requires the actual cargo-built verify-trace binary; deliberately no executable mock.
const map: MapDescriptor = {
  mapName: 'rust-verifier', width: 3, height: 3,
  validTiles: Array.from({ length: 9 }, (_, i) => [i % 3, Math.floor(i / 3)] as [number, number]),
  whiteThrone: [0, 0], blackThrone: [2, 2],
  startingPieces: [
    { id: 1, owner: 'WHITE', type: 'ROCK', pos: [1, 2] },
    { id: 2, owner: 'BLACK', type: 'ROCK', pos: [0, 2] },
  ],
};
const evidence: GameResultEvidence = {
  gameId: 'rust-verifier', winner: 1, reason: 'THRONE_BREACH', disposition: 'DECISIVE',
  executionStatus: 'COMPLETED', rulesRevision: 'ArenaGameplay/v2', totalPly: 1,
  trace: [{ ply: 1, side: 1, move: { pieceId: 1, targetPos: { x: 2, y: 2 } } }],
};

describe('native Rust trace authority', () => {
  it('accepts a real binary throne breach and preserves turn numbering', async () => {
    expect(await new TraceVerifier().verify(map, evidence)).toMatchObject({
      isValid: true, verifiedTurns: 2, finalOutcome: { winner: 1, reason: 'THRONE_BREACH' },
    });
  });
  it('rejects suffixes after terminal instead of silently truncating', async () => {
    const suffix = { ...evidence.trace[0], ply: 2, side: 2 };
    expect((await new TraceVerifier().verify(map, { ...evidence, totalPly: 2, trace: [...evidence.trace, suffix] })).isValid).toBe(false);
  });
  it('rejects skipped plies, wrong winner, reason, disposition and maxTurns', async () => {
    for (const changed of [
      { ...evidence, totalPly: 2 },
      { ...evidence, trace: [{ ...evidence.trace[0], ply: 2 }] },
      { ...evidence, winner: 2 },
      { ...evidence, reason: 'EXTINCTION' },
      { ...evidence, disposition: 'DRAW' as const },
    ]) expect((await new TraceVerifier().verify(map, changed)).isValid).toBe(false);
    expect((await new TraceVerifier().verify(map, evidence, 0)).isValid).toBe(false);
    expect((await new TraceVerifier().verify(map, evidence, 301)).isValid).toBe(false);
  });
  it('does not authenticate caller-supplied observation JSON or TypeScript casts', async () => {
    const forged = { gameId: evidence.gameId, observations: [] } as unknown as AuthenticatedNativeExecution;
    expect((await new TraceVerifier().verify(map, evidence, 300, forged)).error).toBe('UNAUTHENTICATED_NATIVE_EXECUTION');
  });
  it('passes the exact ply budget to Rust and validates the supplied topology', async () => {
    const limited = { ...evidence, reason: 'MAX_TURNS_PROXIMITY', trace: [{ ply: 1, side: 1, move: { pieceId: 1, targetPos: { x: 1, y: 1 } } }] };
    expect((await new TraceVerifier().verify(map, limited, 1)).isValid).toBe(true);
    expect((await new TraceVerifier().verify(map, limited, 2)).isValid).toBe(false);
    expect((await new TraceVerifier().verify({ ...map, width: 0 }, evidence)).isValid).toBe(false);
    expect((await new TraceVerifier().verify({ ...map, mapName: 'x'.repeat(4 * 1024 * 1024) }, evidence)).error).toBe('VERIFIER_INPUT_TOO_LARGE');
  });
  it('fails closed when the binary is unavailable', async () => {
    expect(await new TraceVerifier({ binaryPath: '/nonexistent/oantuti-verifier' }).verify(map, evidence))
      .toMatchObject({ isValid: false, error: expect.stringContaining('RUST_VERIFIER_PROCESS') });
  });
  it('verifies a forfeit prefix but explicitly requires external fault evidence', async () => {
    const result = await new TraceVerifier().verify(map, {
      ...evidence, executionStatus: 'BOT_FORFEIT', winner: 2, reason: 'CRASH_FORFEIT', totalPly: 0, trace: [],
    });
    expect(result).toMatchObject({ isValid: true, requiresSupervisorEvidence: true, finalOutcome: { isGameOver: false } });
    expect((await new TraceVerifier().verify(map, { ...evidence, executionStatus: 'BOT_FORFEIT', reason: 'CRASH_FORFEIT' })).isValid).toBe(false);
  });
});
