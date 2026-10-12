import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { MatchOrchestrator } from '../src/orchestrator.js';
import { PlayerSide, WinReason, MapDescriptor } from '@oantuti/engine';
import sampleDonut from '../../../docs/specs/maps/sample-donut.map.json';

describe('Match Orchestrator & Disqualification Handling', () => {
  const donutMap = sampleDonut as unknown as MapDescriptor;

  it('orchestrates a full match between Greedy Bot and Random Bot', async () => {
    const orchestrator = new MatchOrchestrator({
      matchId: 'match_test_live',
      mapDescriptor: donutMap,
      whiteBotConfig: { path: 'bots/greedy-bot.ts', initTimeoutMs: 2000, turnTimeoutMs: 200 },
      blackBotConfig: { path: 'bots/random-bot.ts', initTimeoutMs: 2000, turnTimeoutMs: 200 },
      maxTurns: 50,
    });

    const result = await orchestrator.runMatch();

    expect(result.matchId).toBe('match_test_live');
    expect(result.totalTurns).toBeGreaterThan(0);
    expect([
      WinReason.EXTINCTION,
      WinReason.THRONE_BREACH,
      WinReason.STALEMATE,
      WinReason.MAX_TURNS_DRAW,
    ]).toContain(result.winReason);
  }, 15000);

  it('disqualifies White with ILLEGAL_MOVE when emitting an illegal move into hole', async () => {
    const illegalBotPath = path.resolve(__dirname, 'fixtures/illegal-bot.ts');

    const orchestrator = new MatchOrchestrator({
      matchId: 'match_test_illegal',
      mapDescriptor: donutMap,
      whiteBotConfig: { path: illegalBotPath, initTimeoutMs: 2000, turnTimeoutMs: 200 },
      blackBotConfig: { path: 'bots/random-bot.ts', initTimeoutMs: 2000, turnTimeoutMs: 200 },
      maxTurns: 50,
    });

    const result = await orchestrator.runMatch();

    expect(result.winner).toBe(PlayerSide.BLACK);
    expect(result.winReason).toBe(WinReason.ILLEGAL_MOVE);
  }, 10000);

  it('disqualifies White with PROTOCOL_VIOLATION when emitting syntax error', async () => {
    const malformedBotPath = path.resolve(__dirname, 'fixtures/malformed-bot.ts');

    const orchestrator = new MatchOrchestrator({
      matchId: 'match_test_protocol',
      mapDescriptor: donutMap,
      whiteBotConfig: { path: malformedBotPath, initTimeoutMs: 2000, turnTimeoutMs: 200 },
      blackBotConfig: { path: 'bots/random-bot.ts', initTimeoutMs: 2000, turnTimeoutMs: 200 },
      maxTurns: 50,
    });

    const result = await orchestrator.runMatch();

    expect(result.winner).toBe(PlayerSide.BLACK);
    expect(result.winReason).toBe(WinReason.PROTOCOL_VIOLATION);
  }, 10000);

  it('disqualifies White with TIMEOUT when exceeding turn time budget', async () => {
    const timeoutBotPath = path.resolve(__dirname, 'fixtures/timeout-bot.ts');

    const orchestrator = new MatchOrchestrator({
      matchId: 'match_test_timeout',
      mapDescriptor: donutMap,
      whiteBotConfig: { path: timeoutBotPath, initTimeoutMs: 2000, turnTimeoutMs: 50 },
      blackBotConfig: { path: 'bots/random-bot.ts', initTimeoutMs: 2000, turnTimeoutMs: 200 },
      maxTurns: 50,
    });

    const result = await orchestrator.runMatch();

    expect(result.winner).toBe(PlayerSide.BLACK);
    expect(result.winReason).toBe(WinReason.TIMEOUT);
  }, 10000);

  it('disqualifies White with CRASH_FORFEIT when bot exits prematurely', async () => {
    const crashBotPath = path.resolve(__dirname, 'fixtures/crash-bot.ts');

    const orchestrator = new MatchOrchestrator({
      matchId: 'match_test_crash',
      mapDescriptor: donutMap,
      whiteBotConfig: { path: crashBotPath, initTimeoutMs: 2000, turnTimeoutMs: 200 },
      blackBotConfig: { path: 'bots/random-bot.ts', initTimeoutMs: 2000, turnTimeoutMs: 200 },
      maxTurns: 50,
    });

    const result = await orchestrator.runMatch();

    expect(result.winner).toBe(PlayerSide.BLACK);
    expect(result.winReason).toBe(WinReason.CRASH_FORFEIT);
    expect(result.whiteStderr).toContain('Fatal crash simulated');
  }, 10000);
});
