import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'path';
import { BotProcess, resolveBotCommand, DisqualificationError } from '../src/ipc-client.js';
import { WinReason } from '@oantuti/engine';

describe('STDIO NDJSON BotProcess & Turn Budget Enforcer', () => {
  const activeProcesses: BotProcess[] = [];

  afterEach(() => {
    while (activeProcesses.length > 0) {
      const p = activeProcesses.pop();
      p?.kill();
    }
  });

  it('resolves bot command for TypeScript files via tsx', () => {
    const res = resolveBotCommand('bots/random-bot.ts');
    expect(res.command).toBe(process.execPath);
    expect(res.args.length).toBe(2);
    expect(res.args[1].endsWith('bots/random-bot.ts')).toBe(true);
  });

  it('performs successful INIT and TURN handshake with Random Bot', async () => {
    const resolved = resolveBotCommand('bots/random-bot.ts');
    const bot = new BotProcess(resolved.command, resolved.args);
    activeProcesses.push(bot);

    const initRes = await bot.sendInit({
      type: 'INIT',
      match_id: 'test_1',
      my_side: 'WHITE',
      map: {
        name: 'Donut Citadel',
        width: 8,
        height: 8,
        valid_tiles: [[0, 0], [1, 1]],
        white_throne: [0, 0],
        black_throne: [1, 1],
      },
      pieces: [{ id: 1, owner: 'WHITE', type: 'ROCK', x: 0, y: 0, is_alive: true }],
      turn_time_limit_ms: 100,
      max_turns: 300,
    }, 2000);

    expect(initRes.timeConsumedMs).toBeGreaterThan(0);

    const turnRes = await bot.sendTurn({
      type: 'TURN',
      turn_number: 1,
      time_remaining_ms: 100,
      pieces: [{ id: 1, owner: 'WHITE', type: 'ROCK', x: 0, y: 0, is_alive: true }],
    }, 1000);

    expect(turnRes.action).toBeDefined();
    expect(turnRes.action.action === 'MOVE' || turnRes.action.action === 'PASS').toBe(true);
  });

  it('disqualifies with TIMEOUT when bot exceeds time limit', async () => {
    const fixturePath = path.resolve(__dirname, 'fixtures/timeout-bot.ts');
    const resolved = resolveBotCommand(fixturePath);
    const bot = new BotProcess(resolved.command, resolved.args);
    activeProcesses.push(bot);

    await bot.sendInit({
      type: 'INIT',
      match_id: 'test_timeout',
      my_side: 'WHITE',
      map: { name: 'M', width: 3, height: 3, valid_tiles: [[0,0]], white_throne: [0,0], black_throne: [1,1] },
      pieces: [],
      turn_time_limit_ms: 50,
      max_turns: 300,
    }, 2000);

    // Turn budget of 50ms, but fixture sleeps 250ms
    try {
      await bot.sendTurn({
        type: 'TURN',
        turn_number: 1,
        time_remaining_ms: 50,
        pieces: [],
      }, 50);
      expect.fail('Should have timed out');
    } catch (err) {
      expect((err as DisqualificationError).reason).toBe(WinReason.TIMEOUT);
    }
  });

  it('disqualifies with PROTOCOL_VIOLATION when bot outputs malformed JSON', async () => {
    const fixturePath = path.resolve(__dirname, 'fixtures/malformed-bot.ts');
    const resolved = resolveBotCommand(fixturePath);
    const bot = new BotProcess(resolved.command, resolved.args);
    activeProcesses.push(bot);

    await bot.sendInit({
      type: 'INIT',
      match_id: 'test_malformed',
      my_side: 'WHITE',
      map: { name: 'M', width: 3, height: 3, valid_tiles: [[0,0]], white_throne: [0,0], black_throne: [1,1] },
      pieces: [],
      turn_time_limit_ms: 100,
      max_turns: 300,
    }, 2000);

    try {
      await bot.sendTurn({
        type: 'TURN',
        turn_number: 1,
        time_remaining_ms: 100,
        pieces: [],
      }, 100);
      expect.fail('Should have thrown PROTOCOL_VIOLATION');
    } catch (err) {
      expect((err as DisqualificationError).reason).toBe(WinReason.PROTOCOL_VIOLATION);
    }
  });

  it('disqualifies with CRASH_FORFEIT when bot process crashes', async () => {
    const fixturePath = path.resolve(__dirname, 'fixtures/crash-bot.ts');
    const resolved = resolveBotCommand(fixturePath);
    const bot = new BotProcess(resolved.command, resolved.args);
    activeProcesses.push(bot);

    await bot.sendInit({
      type: 'INIT',
      match_id: 'test_crash',
      my_side: 'WHITE',
      map: { name: 'M', width: 3, height: 3, valid_tiles: [[0,0]], white_throne: [0,0], black_throne: [1,1] },
      pieces: [],
      turn_time_limit_ms: 100,
      max_turns: 300,
    }, 2000);

    try {
      await bot.sendTurn({
        type: 'TURN',
        turn_number: 1,
        time_remaining_ms: 100,
        pieces: [],
      }, 100);
      expect.fail('Should have thrown CRASH_FORFEIT');
    } catch (err) {
      expect((err as DisqualificationError).reason).toBe(WinReason.CRASH_FORFEIT);
      expect(bot.getStderr()).toContain('Fatal crash simulated');
    }
  });
});
