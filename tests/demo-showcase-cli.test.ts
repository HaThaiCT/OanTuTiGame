import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertShowcaseManifest, parseShowcaseArgs, runShowcaseCli, type ShowcaseQuery } from '../deploy/linux/demo-showcase.js';

const healthy = async (path: string) => {
  if (path.endsWith('/api/health')) return { status: 200, body: { status: 'ok' } };
  if (path.endsWith('/api/health/ready')) return { status: 503, body: { status: 'degraded', productionReady: false, checks: [
    { name: 'database', ok: true }, { name: 'schema', ok: true }, { name: 'objectRoots', ok: true },
    { name: 'executionPlane', ok: false, detail: 'OANTUTI_DEV_EXECUTION=1 arms unsandboxed dev executor' },
    { name: 'backupFence', ok: false, detail: 'off' },
  ] } };
  if (path.endsWith('/api/v2/auth/me')) return { status: 200, body: { user: { id: 'admin', role: 'ADMIN' }, scope: 'FULL', authProfile: 'LAN_OFFLINE' } };
  if (path.endsWith('/api/v2/organizer/accounts')) return { status: 200, body: { accounts: [] } };
  if (path.endsWith('/api/v2/organizer/runner-status')) return { status: 200, body: { enabled: true } };
  if (path.endsWith('/api/v2/maps')) return { status: 200, body: { maps: [] } };
  if (path.endsWith('/api/v2/tournaments')) return { status: 200, body: { tournaments: [] } };
  return { status: 404, body: null };
};

async function tempRoot() { const parent = await mkdtemp(join(tmpdir(), 'showcase-cli-')); const root = join(parent, 'runtime'); return { root, cleanup: () => rm(parent, { recursive: true, force: true }) }; }
function dependencies(root: string, extras: { env?: Record<string,string>; fetch?: (url:string,init?:{method?:string;headers?:Record<string,string>})=>Promise<{status:number;body:unknown}>; db?: ShowcaseQuery } = {}) {
  const calls:string[]=[];
  const fetch=extras.fetch??(async(url,init)=>{const path=new URL(url).pathname;calls.push(`${init?.method??'GET'} ${path}`);return healthy(path);});
  const db:ShowcaseQuery=extras.db??(async(sql)=>{calls.push(`SQL ${sql}`);if(sql.includes('current_database'))return{rows:[{name:'arena_rebuild_c72cd5a74f33'}]};if(sql.includes('accountCapacity'))return{rows:[{value:{limit:600}}]};if(sql.includes('count(*)::text AS count FROM users'))return{rows:[{count:'30'}]};return{rows:[]};});
  return { deps:{env:{OANTUTI_DEMO_RUNTIME_ROOT:root,OANTUTI_SHOWCASE_ADMIN_COOKIE:`oantuti_session=${'a'.repeat(64)}`,OANTUTI_SHOWCASE_CONFIRM:'SHOWCASE',OANTUTI_DEV_EXECUTION:'1',OANTUTI_API:'http://127.0.0.1:4301',PGHOST:'/tmp/pg',PGPORT:'55434',PGUSER:'arena_app',PGDATABASE:'arena_rebuild_c72cd5a74f33',...(extras.env??{})},fetch,db},calls };
}

describe('demo showcase CLI safety preflight',()=>{
  it('defaults to deterministic zero-I/O dry-run',async()=>{const sandbox=await tempRoot();const d=dependencies(sandbox.root,{fetch:async()=>{throw new Error('unexpected fetch')},db:async()=>{throw new Error('unexpected query')}});try{const result=await runShowcaseCli(['--tag','SHOWCASE','--seed','stable','--count','4'],d.deps);expect(result.mode).toBe('dry-run');expect(result.plan.contests).toHaveLength(4);await expect(stat(sandbox.root)).rejects.toThrow();expect(d.calls).toEqual([]);}finally{await sandbox.cleanup();}});
  it('requires confirmation, explicit development execution and ADMIN cookie before any I/O',async()=>{const sandbox=await tempRoot();let calls=0;try{for(const env of [{OANTUTI_SHOWCASE_CONFIRM:'wrong',OANTUTI_DEV_EXECUTION:'1',OANTUTI_SHOWCASE_ADMIN_COOKIE:`oantuti_session=${'a'.repeat(64)}`},{OANTUTI_SHOWCASE_CONFIRM:'SHOWCASE',OANTUTI_DEV_EXECUTION:'',OANTUTI_SHOWCASE_ADMIN_COOKIE:`oantuti_session=${'a'.repeat(64)}`},{OANTUTI_SHOWCASE_CONFIRM:'SHOWCASE',OANTUTI_DEV_EXECUTION:'1',OANTUTI_SHOWCASE_ADMIN_COOKIE:''}])await expect(runShowcaseCli(['--tag','SHOWCASE','--seed','stable','--run'],{env:{...dependencies(sandbox.root).deps.env,...env},fetch:async()=>{calls++;return{status:200,body:{}}},db:async()=>{calls++;return{rows:[]}}})).rejects.toThrow();expect(calls).toBe(0);await expect(stat(sandbox.root)).rejects.toThrow();}finally{await sandbox.cleanup();}});
  it('rejects bad readiness, non-ADMIN, tag collisions and insufficient capacity before manifest creation',async()=>{const sandbox=await tempRoot();try{const d=dependencies(sandbox.root);const badReady=dependencies(sandbox.root,{fetch:async url=>new URL(url).pathname.endsWith('/api/health/ready')?{status:503,body:{...((await healthy('/api/health/ready')).body as object),checks:[{name:'schema',ok:false}]}}:healthy(new URL(url).pathname)});await expect(runShowcaseCli(['--tag','SHOWCASE','--seed','stable','--run'],badReady.deps)).rejects.toThrow();const student=dependencies(sandbox.root,{fetch:async url=>new URL(url).pathname.endsWith('/auth/me')?{status:200,body:{user:{role:'STUDENT'},scope:'FULL',authProfile:'LAN_OFFLINE'}}:healthy(new URL(url).pathname)});await expect(runShowcaseCli(['--tag','SHOWCASE','--seed','stable','--run'],student.deps)).rejects.toThrow();const collision=dependencies(sandbox.root,{db:async(sql,params)=>sql.includes('FROM courses')?{rows:[{code:'SHOWCASE_C1'}]}:d.deps.db!(sql,params)});await expect(runShowcaseCli(['--tag','SHOWCASE','--seed','stable','--run'],collision.deps)).rejects.toThrow();const capacity=dependencies(sandbox.root,{db:async(sql,params)=>sql.includes('accountCapacity')?{rows:[{value:{limit:80}}]}:d.deps.db!(sql,params)});await expect(runShowcaseCli(['--tag','SHOWCASE','--seed','stable','--run'],capacity.deps)).rejects.toThrow();await expect(stat(sandbox.root)).rejects.toThrow();}finally{await sandbox.cleanup();}});
  it('rejects unsafe API origins before sending requests',async()=>{const sandbox=await tempRoot();let calls=0;try{const d=dependencies(sandbox.root,{env:{OANTUTI_API:'https://example.org'},fetch:async()=>{calls++;return{status:200,body:{}}}});await expect(runShowcaseCli(['--tag','SHOWCASE','--seed','stable','--run'],d.deps)).rejects.toThrow(/loopback HTTP origin/);expect(calls).toBe(0);}finally{await sandbox.cleanup();}});
  it('rejects repository-local runtime roots before creating files',async()=>{const d=dependencies(process.cwd());await expect(runShowcaseCli(['--tag','SHOWCASE','--seed','stable','--run'],d.deps)).rejects.toThrow(/outside the repository/);});
  it('limits tags so generated course codes fit the API field',()=>{expect(()=>parseShowcaseArgs(['--tag','x'.repeat(28),'--seed','stable'])).toThrow();expect(parseShowcaseArgs(['--tag','x'.repeat(27),'--seed','stable']).tag).toBe('x'.repeat(27));});
  it('rejects partial contest counts in write mode',()=>{expect(()=>parseShowcaseArgs(['--tag','SHOWCASE','--seed','stable','--count','4','--run'])).toThrow(/complete 30-contest plan/);});
  it('requires exact plan metadata and explicit resume for an existing manifest',()=>{
    const plan={version:1 as const,tag:'SHOWCASE',seed:'stable',digest:'a'.repeat(64)};
    const manifest={version:1 as const,tag:'SHOWCASE',seed:'stable',planDigest:plan.digest,completed:[],preservedTournamentIds:[]};
    expect(()=>assertShowcaseManifest(undefined,plan,true)).toThrow(/requires an existing matching manifest/);
    expect(()=>assertShowcaseManifest({...manifest,seed:'other'},plan,false)).toThrow(/does not exactly match/);
    expect(()=>assertShowcaseManifest(manifest,plan,true)).not.toThrow();
    expect(()=>assertShowcaseManifest(manifest,plan,false)).toThrow(/pass --resume/);
  });
});
