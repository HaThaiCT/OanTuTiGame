import {it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/app.js';
it('allows owned submissions until only the organizer locks the roster', async()=>{
 const dir=mkdtempSync(join(tmpdir(),'arena-roster-'));
 const ctx=await createApp({botsDir:join(dir,'bots'),replaysDir:join(dir,'replays')});
 async function register(username:string){const r=await ctx.app.inject({method:'POST',url:'/api/auth/register',payload:{username,email:username+'@example.test',password:'roster-password-123'}});return String(r.headers['set-cookie']).split(';')[0];}
 try{
 const owner=await register('organizer'),player=await register('playerone');
 const created=await ctx.app.inject({method:'POST',url:'/api/tournaments',headers:{cookie:owner},payload:{name:'Registration cup',mapId:'sample-donut',format:'SWISS',registrationOnly:true}});
 expect(created.statusCode).toBe(200);const id=created.json().tournament.id;
 const code='import sys,json\nfor l in sys.stdin:\n m=json.loads(l)\n print(json.dumps({"status":"READY"} if m["type"]=="INIT" else {"action":"PASS"}),flush=True)';
 const bot=(await ctx.app.inject({method:'POST',url:'/api/bots',headers:{cookie:player},payload:{name:'Entry',language:'PYTHON',sourceCode:code}})).json().bot;
 expect((await ctx.app.inject({method:'POST',url:`/api/tournaments/${id}/entries`,headers:{cookie:owner},payload:{botId:bot.id}})).statusCode).toBe(404);
 expect((await ctx.app.inject({method:'POST',url:`/api/tournaments/${id}/entries`,headers:{cookie:player},payload:{botId:bot.id}})).statusCode).toBe(200);
 expect((await ctx.app.inject({method:'POST',url:`/api/tournaments/${id}/lock`,headers:{cookie:player},payload:{}})).statusCode).toBe(403);
 expect(ctx.db.getTournamentById(id)?.status).toBe('PENDING');
 const other=(await ctx.app.inject({method:'POST',url:'/api/bots',headers:{cookie:owner},payload:{name:'Other',language:'PYTHON',sourceCode:code}})).json().bot;
 await ctx.app.inject({method:'POST',url:`/api/tournaments/${id}/entries`,headers:{cookie:owner},payload:{botId:other.id}});
 const complete=Promise.withResolvers<void>();ctx.tournamentService.once('tournament:complete',()=>complete.resolve());ctx.tournamentService.once('tournament:error',e=>complete.reject(e.error));
 expect((await ctx.app.inject({method:'POST',url:`/api/tournaments/${id}/lock`,headers:{cookie:owner},payload:{}})).statusCode).toBe(200);
 expect((await ctx.app.inject({method:'POST',url:`/api/tournaments/${id}/entries`,headers:{cookie:player},payload:{botId:bot.id}})).statusCode).toBe(409);
 await complete.promise;
 expect(ctx.tournamentService.getTournamentDetails(id).standings).toHaveLength(2);
 }finally{await ctx.app.close();ctx.db.close();rmSync(dir,{recursive:true,force:true});}
});
