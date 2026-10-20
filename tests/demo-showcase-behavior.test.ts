import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MatchOrchestrator } from '../packages/runner/src/orchestrator.js';
import { buildShowcaseBot, buildShowcaseMap } from '../deploy/linux/demo-showcase-assets.js';

describe('showcase strategy behavior',()=>{
  it('launches every SDK variant and produces multiple deterministic action traces',async()=>{
    const root=await mkdtemp(join(tmpdir(),'showcase-behavior-'));
    try{
      const signatures:string[]=[];const outcomes:string[]=[];const paths:string[]=[];
      for(let slot=0;slot<12;slot++){
        const bot=buildShowcaseBot(slot);const directory=join(root,String(slot));
        const {mkdir}=await import('node:fs/promises');await mkdir(directory);
        for(const file of bot.files){const path=join(directory,file.path);await writeFile(path,file.contents);if(file.path===bot.entrypoint)paths.push(path);}
      }
      const mapDescriptor=buildShowcaseMap(0).descriptor;
      for(let slot=0;slot<12;slot++){
        const match=await new MatchOrchestrator({mapDescriptor,whiteBotConfig:{path:paths[slot]},blackBotConfig:{path:paths[0]},maxTurns:80,matchId:`showcase-${slot}`}).runMatch();
        expect(['CRASH_FORFEIT','PROTOCOL_VIOLATION','TIMEOUT','ILLEGAL_MOVE']).not.toContain(match.winReason);
        outcomes.push(`${match.winner}:${match.winReason}:${match.totalTurns}`);
        signatures.push(JSON.stringify({slot,winner:match.winner,reason:match.winReason,turns:match.turns.map(({player,action})=>[player,action])}));
      }
      expect(new Set(signatures).size,signatures.join('\n')).toBeGreaterThanOrEqual(4);
      expect(new Set(outcomes).size).toBeGreaterThanOrEqual(2);
    }finally{await rm(root,{recursive:true,force:true});}
  });
});
