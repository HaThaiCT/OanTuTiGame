import { describe, expect, it } from 'vitest';
import { describePublicGameResult, normalizePublicGameResult } from './public-game-result';

describe('normalizePublicGameResult', () => {
  it('normalizes public snake-case and camel-case payloads without exposing private digests', () => {
    expect(normalizePublicGameResult({
      game_id: 'game-1', winner: 2, reason: 'THRONE_BREACH', disposition: 'DECISIVE', total_turns: '18', revision: 3,
      accepted_at: '2026-10-22T10:00:00.000Z', replayDigest: 'private-replay', manifestDigest: 'private-manifest', actionTraceDigest: 'private-trace',
    })).toEqual({ gameId: 'game-1', winner: 2, reason: 'THRONE_BREACH', disposition: 'DECISIVE', totalTurns: 18, revision: 3, acceptedAt: '2026-10-22T10:00:00.000Z' });
    expect(normalizePublicGameResult({ gameId: 'game-2', winner: 0, reason: 'MAX_TURNS_DRAW', disposition: 'DRAW', totalTurns: 300 })).toMatchObject({ gameId: 'game-2', winner: 0, disposition: 'DRAW', totalTurns: 300 });
  });
  it('rejects missing, null, or inconsistent outcome fields instead of inventing a draw', () => {
    expect(normalizePublicGameResult({ gameId: 'g', totalTurns: 0, reason: 'MAX_TURNS_DRAW', disposition: 'DRAW' })).toBeNull();
    expect(normalizePublicGameResult({ gameId: 'g', winner: null, totalTurns: 0, reason: 'MAX_TURNS_DRAW', disposition: 'DRAW' })).toBeNull();
    expect(normalizePublicGameResult({ gameId: 'g', winner: 0, totalTurns: null, reason: 'MAX_TURNS_DRAW', disposition: 'DRAW' })).toBeNull();
    expect(normalizePublicGameResult({ gameId: 'g', winner: 1, totalTurns: 2, reason: 'THRONE_BREACH', disposition: 'DRAW' })).toBeNull();
  });
});

describe('describePublicGameResult', () => {
  it('labels both decisive sides and a no-contest without internal codes', () => {
    expect(describePublicGameResult({ gameId: 'g', winner: 1, reason: 'MAX_TURNS_PROXIMITY', disposition: 'DECISIVE', totalTurns: 301, revision: 1, acceptedAt: null })).toEqual({ winner: 'Quân Trắng thắng', reason: 'Hết lượt tối đa — so sánh khoảng cách tới ngai', disposition: 'Phân thắng bại' });
    expect(describePublicGameResult({ gameId: 'g', winner: 2, reason: 'EXTINCTION', disposition: 'DECISIVE', totalTurns: 8, revision: 1, acceptedAt: null }).winner).toBe('Quân Đen thắng');
    expect(describePublicGameResult({ gameId: 'g', winner: 0, reason: 'INVALID_START_BOTH_SIDES', disposition: 'NO_CONTEST', totalTurns: 0, revision: null, acceptedAt: null }).winner).toBe('Không tính kết quả');
  });
});
