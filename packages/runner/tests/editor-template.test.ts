import { it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { MatchOrchestrator } from '../src/orchestrator.js';
import { MapDescriptor, WinReason } from '@oantuti/engine';
import { PYTHON_BOT_TEMPLATE, TYPESCRIPT_BOT_TEMPLATE, CPP_BOT_TEMPLATE } from '../../web/src/editor/templates.js';
import sample from '../../../docs/specs/maps/sample-donut.map.json';

it.each([['Python','py',PYTHON_BOT_TEMPLATE],['TypeScript','ts',TYPESCRIPT_BOT_TEMPLATE],['C++','cpp',CPP_BOT_TEMPLATE]])('runs the %s editor template as actual submitted code', async (_language, extension, source) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'arena-editor-template-'));
  const botPath = path.join(directory, 'bot.' + extension);
  writeFileSync(botPath, source);
  try {
    // Shared map fixture is already validated against its schema by the specs suite.
    const descriptor = sample as MapDescriptor;
    const result = await new MatchOrchestrator({
      mapDescriptor: descriptor,
      whiteBotConfig: {path:botPath},
      blackBotConfig: {path:path.resolve('sdk/python/starter_bot.py')},
      maxTurns:1,
    }).runMatch();
    expect(result.winReason, result.whiteStderr).toBe(WinReason.MAX_TURNS_DRAW);
    expect(result.turns[0].action).toEqual({action:'MOVE',pieceId:1,target:[0,2]});
  } finally { rmSync(directory, {recursive:true,force:true}); }
});
