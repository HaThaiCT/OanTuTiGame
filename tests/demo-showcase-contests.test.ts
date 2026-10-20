import { describe, expect, it } from 'vitest';
import { runShowcaseContest, type ShowcaseContestApi, type ShowcaseContestDb } from '../deploy/linux/demo-showcase-contests.js';
import { buildShowcasePlan } from '../deploy/linux/demo-showcase-plan.js';

describe('showcase contest runner',()=>{
  it('stops on a RUNNING contest that has no first round rather than fabricating progress',async()=>{
    const plan=buildShowcasePlan('SHOWCASE','stable',1).contests[0];
    const api:ShowcaseContestApi=async()=>({status:200,body:{}});
    const db:ShowcaseContestDb=async(sql)=>sql.includes('FROM tournaments t')?{rows:[{id:'tournament-id',name:plan.name,state:'RUNNING',version:4,format:plan.format,is_rated:true,course_code:'SHOWCASE_C1'}]}:{rows:[]};
    await expect(runShowcaseContest({tag:'SHOWCASE',contest:plan,teamIds:Array.from({length:48},(_,i)=>`team-${i}`),mapSlugs:Array.from({length:12},(_,i)=>`map-${i}`),api,db,adminCookie:()=>`oantuti_session=${'a'.repeat(64)}`,adminReauthenticate:async()=>undefined,authenticateStudent:async()=>({cookie:'oantuti_session='+'a'.repeat(64)}),checkpoint:async()=>undefined,readCheckpoint:()=>undefined,wait:async()=>undefined})).rejects.toThrow(/RUNNING with no round-one schedule/);
  });
  it('keeps PENDING, REJECTED and Unrated examples outside published rating generations',async()=>{
    const plan=buildShowcasePlan('SHOWCASE','stable').contests[0];
    const make=async(reviewOutcome:'PENDING'|'REJECT'|'UNRATED')=>{
      const writes:string[]=[];let rejected=false;let auth=0;
      const api:ShowcaseContestApi=async(method,path)=>{
        if(method!=='GET')writes.push(`${method} ${path}`);
        if(path==='/api/v2/ratings/teams')return{status:200,body:{publication:{generationId:'7',activeRevision:'9',desiredRevision:'9',updating:false}}};
        if(path.endsWith('/rating-review'))return{status:200,body:{isRated:true,status:rejected?'REJECTED':'PENDING',updating:false,previewDigest:'a'.repeat(64),sourceDigest:'b'.repeat(64),tournamentVersion:4,changes:[1,2,3,4]}};
        if(path.endsWith('/rating-reject')){rejected=true;return{status:200,body:{status:'REJECTED'}};}
        if(path.endsWith('/rating-changes'))return{status:200,body:{isRated:false,reviewState:'UNRATED',changes:[]}};
        return{status:200,body:{}};
      };
      const db:ShowcaseContestDb=async(sql)=>{
        if(sql.includes('FROM tournaments t'))return{rows:[{id:'tournament-id',name:plan.name,state:'FINALIZED',version:4,format:plan.format,is_rated:reviewOutcome!=='UNRATED',course_code:'SHOWCASE_C1'}]};
        if(sql.includes('FROM tournament_map_pool'))return{rows:[{slug:'map-0'},{slug:'map-1'},{slug:'map-2'},{slug:'map-3'}]};
        if(sql.includes('FROM tournament_map_commitments'))return{rows:[{slug:'map-0'}]};
        if(sql.includes('AS total'))return{rows:[{total:4,completed:4,nonterminal:0,missing_accepted:0,unsealed:0,accepted:4}]};
        return{rows:[]};
      };
      const result=await runShowcaseContest({tag:'SHOWCASE',contest:{...plan,rated:reviewOutcome!=='UNRATED'},reviewOutcome,teamIds:Array.from({length:48},(_,i)=>`team-${i}`),mapSlugs:Array.from({length:12},(_,i)=>`map-${i}`),api,db,adminCookie:()=>`oantuti_session=${'a'.repeat(64)}`,adminReauthenticate:async()=>{auth++;},authenticateStudent:async()=>({cookie:`oantuti_session=${'b'.repeat(64)}`}),checkpoint:async()=>undefined,readCheckpoint:()=>undefined,wait:async()=>undefined});
      return{result,writes,auth};
    };
    const pending=await make('PENDING');expect(pending.result.reviewOutcome).toBe('PENDING');expect(pending.writes).toEqual([]);
    const rejected=await make('REJECT');expect(rejected.result.reviewOutcome).toBe('REJECT');expect(rejected.auth).toBe(1);expect(rejected.writes.some((path)=>path.endsWith('/rating-reject'))).toBe(true);expect(rejected.writes.some((path)=>path.endsWith('/rating-approve'))).toBe(false);
    const unrated=await make('UNRATED');expect(unrated.result.reviewOutcome).toBe('UNRATED');expect(unrated.writes.some((path)=>path.endsWith('/rating-review'))).toBe(false);expect(unrated.writes.some((path)=>path.endsWith('/rating-approve'))).toBe(false);
  });
});
