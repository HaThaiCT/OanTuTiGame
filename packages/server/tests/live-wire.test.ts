import { describe, expect, it } from 'vitest';
import { parseLiveMessage, sameLiveIdentity } from '../../web/lib/live.js';

const identity = { gameId: 'game', attemptId: 'attempt', fencingToken: '7', deploymentGeneration: 2 };
const ply = { seq: 1, turnNumber: 1, side: 1, action: { action: 'PASS' } };

describe('live spectator wire identity and acceptance', () => {
  it('never interprets preview metadata as an accepted outcome', () => {
    const message = parseLiveMessage({ type: 'SNAPSHOT', ...identity, status: 'PREVIEW_ENDED', seq: 1, historyComplete: true, events: [ply], result: { winner: 2, reason: 'preview' } });
    expect(message?.type).toBe('SNAPSHOT');
    if (message?.type !== 'SNAPSHOT') throw new Error('snapshot not parsed');
    expect(message.snapshot.outcome).toBeNull();
    expect(parseLiveMessage({ type: 'PREVIEW_ENDED', ...identity })).toEqual({ type: 'PREVIEW_ENDED', identity });
    expect(parseLiveMessage({ type: 'RESULT', ...identity, winner: 1, reason: 'THRONE_BREACH' })).toEqual({ type: 'RESULT', identity, outcome: { winner: 1, reason: 'THRONE_BREACH' } });
  });

  it('rejects missing identities, broken sequence history and false complete snapshots', () => {
    expect(parseLiveMessage({ type: 'EVENT', gameId: 'game', ...ply })).toBeNull();
    const snapshot = { type: 'SNAPSHOT', ...identity, status: 'RUNNING', seq: 2, historyComplete: true, events: [{ ...ply, seq: 2 }] };
    expect(parseLiveMessage(snapshot)).toBeNull();
    expect(parseLiveMessage({ ...snapshot, historyComplete: false })?.type).toBe('SNAPSHOT');
    expect(parseLiveMessage({ ...snapshot, seq: 3, events: [ply, { ...ply, seq: 3 }] })).toBeNull();
    expect(parseLiveMessage({ ...snapshot, seq: 3, historyComplete: false })).toBeNull();
  });

  it('distinguishes old attempt, fence, generation and game frames', () => {
    expect(sameLiveIdentity(identity, identity)).toBe(true);
    expect(sameLiveIdentity(identity, { ...identity, attemptId: 'old' })).toBe(false);
    expect(sameLiveIdentity(identity, { ...identity, fencingToken: '6' })).toBe(false);
    expect(sameLiveIdentity(identity, { ...identity, deploymentGeneration: 1 })).toBe(false);
    expect(sameLiveIdentity(identity, { ...identity, gameId: 'other' })).toBe(false);
  });
});
