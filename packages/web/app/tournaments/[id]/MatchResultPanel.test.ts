import { describe, expect, it } from 'vitest';
import { matchResultPanelLabel } from './MatchResultPanel';
import { normalizePublicGameResult } from '../../../lib/public-game-result';

describe('matchResultPanelLabel', () => {
  it('describes accepted result sides and no-contest without internal codes', () => {
    expect(matchResultPanelLabel({ gameId: 'g', winner: 1, reason: 'THRONE_BREACH', disposition: 'DECISIVE', totalTurns: 12, revision: 1, acceptedAt: null })).toEqual({ winner: 'Quân Trắng thắng', reason: 'Chiếm ngai đối phương', disposition: 'Phân thắng bại' });
    expect(matchResultPanelLabel({ gameId: 'g', winner: 0, reason: 'INVALID_START_BOTH_SIDES', disposition: 'NO_CONTEST', totalTurns: 0, revision: null, acceptedAt: null }).winner).toBe('Không tính kết quả');
  });
  it('refuses payloads without a valid reason and disposition rather than fabricating an outcome', () => {
    expect(normalizePublicGameResult({ gameId: 'g', winner: 1, totalTurns: 5 })).toBeNull();
    expect(normalizePublicGameResult({ gameId: 'g', winner: 1, reason: 'THRONE_BREACH', disposition: 'OTHER', totalTurns: 5 })).toBeNull();
    expect(normalizePublicGameResult({ gameId: 'g', winner: 9, reason: 'THRONE_BREACH', disposition: 'DECISIVE', totalTurns: 5 })).toBeNull();
  });
});
