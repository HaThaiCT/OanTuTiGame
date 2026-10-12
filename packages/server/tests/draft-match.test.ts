import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Database } from '../src/db.js';
import { MatchService } from '../src/match-service.js';
import { WinReason, PlayerSide } from '@oantuti/engine';
import { unpackReplay } from '@oantuti/protocol';

const source = `import sys, json
for line in sys.stdin:
    message = json.loads(line)
    if message['type'] == 'INIT':
        print(json.dumps({'status': 'READY'}), flush=True)
    elif message['type'] == 'TURN':
        print(json.dumps({'action': 'MOVE', 'piece_id': 1, 'target': [0, 2]}), flush=True)
`;

describe('Unranked editor draft matches', () => {
  it('executes the submitted source and supplies replay without adding registry or ELO entries', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'arena-draft-'));
    const db = new Database();
    const service = new MatchService(db, undefined, path.join(directory, 'replays'));
    const opponent = db.createBot({userId:'usr_system',name:'Opponent',language:'TYPESCRIPT',sourceCode:'system bot',filePath:path.resolve('bots/random-bot.ts')});
    const before = db.listBots();
    try {
      const {matchId} = await service.startTestMatch({mapId:'sample-donut',opponentBotId:opponent.id,language:'PYTHON',sourceCode:source,maxTurns:1});
      const result = await service.waitForMatch(matchId);
      expect(result.turns).toMatchObject([{player:PlayerSide.WHITE,action:{action:'MOVE',pieceId:1,target:[0,2]}}]);
      expect(result.winReason).toBe(WinReason.MAX_TURNS_DRAW);
      expect(db.listBots()).toEqual(before);
      expect(db.getMatchById(matchId)).toBeUndefined();
      expect(db.getReplayByMatchId(matchId)).toBeUndefined();
      const active = service.getActiveMatch(matchId)!;
      expect(active.isFinished).toBe(true);
      const replay = unpackReplay(active.replayBinary!);
      expect(replay.deltas[0].action?.targetPos).toEqual({x:0,y:2});
      expect(replay.end.reason).toBe(result.winReason);
    } finally { db.close(); rmSync(directory, {recursive:true,force:true}); }
  });

  it('returns a crash result for invalid draft code, rather than replacing it with a starter bot', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'arena-draft-'));
    const db = new Database();
    const service = new MatchService(db, undefined, path.join(directory, 'replays'));
    const opponent = db.createBot({userId:'usr_system',name:'Opponent',language:'TYPESCRIPT',sourceCode:'system bot',filePath:path.resolve('bots/random-bot.ts')});
    try {
      const {matchId} = await service.startTestMatch({mapId:'sample-donut',opponentBotId:opponent.id,language:'PYTHON',sourceCode:'this is not valid python :',maxTurns:1});
      const result = await service.waitForMatch(matchId);
      expect(result.winner).toBe(PlayerSide.BLACK);
      expect(result.winReason).toBe(WinReason.CRASH_FORFEIT);
      expect(result.totalTurns).toBe(0);
      expect(result.whiteStderr).toContain('SyntaxError');
      expect(db.listBots().map(bot=>bot.id)).toEqual([opponent.id]);
    } finally { db.close(); rmSync(directory, {recursive:true,force:true}); }
  });
});
