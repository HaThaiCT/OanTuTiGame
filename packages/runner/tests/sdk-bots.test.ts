import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { MatchOrchestrator } from '../src/orchestrator.js';
import { PlayerSide, MapDescriptor } from '@oantuti/engine';
import sampleDonut from '../../../docs/specs/maps/sample-donut.map.json';

describe('Multi-Language SDK Bots Test Suite (Python, TypeScript, C++)', () => {
  const mapDesc = sampleDonut as unknown as MapDescriptor;

  it('runs match with Python 3 SDK starter bot against RandomBot', async () => {
    const pythonBotPath = path.resolve(process.cwd(), 'sdk/python/starter_bot.py');
    const randomBotPath = path.resolve(process.cwd(), 'bots/random-bot.ts');

    const orchestrator = new MatchOrchestrator({
      matchId: 'sdk_test_python',
      mapDescriptor: mapDesc,
      whiteBotConfig: { path: pythonBotPath, initTimeoutMs: 2000, turnTimeoutMs: 200 },
      blackBotConfig: { path: randomBotPath, initTimeoutMs: 2000, turnTimeoutMs: 200 },
      maxTurns: 40,
    });

    const result = await orchestrator.runMatch();

    expect(result.matchId).toBe('sdk_test_python');
    expect(result.totalTurns).toBeGreaterThan(0);
    // Python bot should play valid moves and beat or draw against RandomBot
    expect(result.winner).toBe(PlayerSide.WHITE);
  }, 15000);

  it('runs match with TypeScript SDK starter bot against RandomBot', async () => {
    const tsBotPath = path.resolve(process.cwd(), 'sdk/typescript/starter_bot.ts');
    const randomBotPath = path.resolve(process.cwd(), 'bots/random-bot.ts');

    const orchestrator = new MatchOrchestrator({
      matchId: 'sdk_test_ts',
      mapDescriptor: mapDesc,
      whiteBotConfig: { path: tsBotPath, initTimeoutMs: 2000, turnTimeoutMs: 200 },
      blackBotConfig: { path: randomBotPath, initTimeoutMs: 2000, turnTimeoutMs: 200 },
      maxTurns: 40,
    });

    const result = await orchestrator.runMatch();

    expect(result.matchId).toBe('sdk_test_ts');
    expect(result.totalTurns).toBeGreaterThan(0);
    expect(result.winner).toBe(PlayerSide.WHITE);
  }, 15000);

  it('runs match with C++20 SDK starter bot against RandomBot', async () => {
    const cppBotPath = path.resolve(process.cwd(), 'sdk/cpp/starter_bot.cpp');
    const randomBotPath = path.resolve(process.cwd(), 'bots/random-bot.ts');

    const orchestrator = new MatchOrchestrator({
      matchId: 'sdk_test_cpp',
      mapDescriptor: mapDesc,
      whiteBotConfig: { path: cppBotPath, initTimeoutMs: 2000, turnTimeoutMs: 200 },
      blackBotConfig: { path: randomBotPath, initTimeoutMs: 2000, turnTimeoutMs: 200 },
      maxTurns: 40,
    });

    const result = await orchestrator.runMatch();

    expect(result.matchId).toBe('sdk_test_cpp');
    expect(result.totalTurns).toBeGreaterThan(0);
    expect(result.winner).toBe(PlayerSide.WHITE);
  }, 15000);
});
