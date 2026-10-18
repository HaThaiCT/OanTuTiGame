import { it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { MatchOrchestrator } from '../src/orchestrator.js';
import { MapDescriptor, WinReason } from '@oantuti/engine';
import { PYTHON_BOT_TEMPLATE, TYPESCRIPT_BOT_TEMPLATE, CPP_BOT_TEMPLATE } from '@oantuti/protocol/bot-templates';
import sample from '../../../docs/specs/maps/sample-donut.map.json';

/**
 * The starter templates that ship in the workspace IDE must run as real submitted code. The
 * assertion stays structural — the template starts, answers INIT, and plays one legal move that
 * the engine accepts (an illegal or unparseable move would end the game with a forfeit reason
 * instead of MAX_TURNS_DRAW). Which tile the starter heuristics happens to pick is not pinned.
 */
it.each([
  ['Python', 'py', PYTHON_BOT_TEMPLATE],
  ['TypeScript', 'ts', TYPESCRIPT_BOT_TEMPLATE],
  ['C++', 'cpp', CPP_BOT_TEMPLATE],
])('runs the %s editor template as actual submitted code', async (_language, extension, source) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'arena-editor-template-'));
  const botPath = path.join(directory, 'bot.' + extension);
  writeFileSync(botPath, source);
  try {
    // Shared map fixture is already validated against its schema by the specs suite.
    const descriptor = sample as MapDescriptor;
    const result = await new MatchOrchestrator({
      mapDescriptor: descriptor,
      whiteBotConfig: { path: botPath },
      blackBotConfig: { path: path.resolve('sdk/python/starter_bot.py') },
      maxTurns: 1,
    }).runMatch();

    expect(result.winReason, result.whiteStderr).toBe(WinReason.MAX_TURNS_DRAW);
    expect(result.turns).toHaveLength(1);

    const first = result.turns[0].action;
    expect(first.action).toBe('MOVE');
    expect(first.pieceId).toBe(1);
    expect(first.target).toHaveLength(2);

    const start = descriptor.startingPieces.find((piece) => piece.id === 1);
    expect(start, 'fixture must contain piece 1').toBeDefined();
    const [targetX, targetY] = first.target;
    expect([targetX, targetY]).not.toEqual(start!.pos);
    expect(targetX).toBeGreaterThanOrEqual(0);
    expect(targetY).toBeGreaterThanOrEqual(0);
    expect(targetX).toBeLessThan(descriptor.width);
    expect(targetY).toBeLessThan(descriptor.height);
    expect(descriptor.validTiles.some(([x, y]) => x === targetX && y === targetY)).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
