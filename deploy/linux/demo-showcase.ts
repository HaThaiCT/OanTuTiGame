#!/usr/bin/env -S /home/ha-thai/.local/bin/node --import tsx
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { buildShowcasePlan, type ShowcasePlan } from './demo-showcase-plan.js';
import { buildShowcaseIdentities } from './demo-showcase-identities.js';
import { provisionShowcaseBase, type ShowcaseCredentials } from './demo-showcase-provision.js';
import { withShowcaseLock } from './demo-showcase-lock.js';
import { authenticateShowcaseStudent } from './demo-showcase-auth.js';
import { runShowcaseContest } from './demo-showcase-contests.js';
import { buildShowcaseBot, buildShowcaseMap } from './demo-showcase-assets.js';

interface Options { readonly tag: string; readonly seed: string; readonly count: number; readonly run: boolean; readonly resume: boolean }
interface Response { readonly status: number; readonly body: unknown; readonly headers?: { get(name: string): string | null } }
export type ShowcaseFetch = (url: string, init?: { readonly method?: string; readonly headers?: Record<string,string>; readonly body?: string }) => Promise<Response>;
export type ShowcaseQuery = (sql: string, params?: readonly unknown[]) => Promise<{ readonly rows: readonly Record<string,unknown>[] }>;
interface Dependencies { readonly env?: NodeJS.ProcessEnv; readonly fetch?: ShowcaseFetch; readonly db?: ShowcaseQuery; readonly readFile?: typeof readFile; readonly writeFile?: typeof writeFile; readonly mkdir?: typeof mkdir; readonly chmod?: typeof chmod; readonly rename?: typeof rename }
export interface ShowcaseCliResult { readonly mode: 'dry-run'|'complete'; readonly plan: ShowcasePlan; readonly manifestPath?: string }

export function parseShowcaseArgs(argv: readonly string[]): Options {
  const values: Record<string,string> = {}; let run=false; let resume=false;
  for(let i=0;i<argv.length;i++) {
    const arg=argv[i];
    if(arg==='--run'){if(run)throw new Error('duplicate --run');run=true;continue;}
    if(arg==='--resume'){if(resume)throw new Error('duplicate --resume');resume=true;continue;}
    if(!['--tag','--seed','--count'].includes(arg)||!argv[i+1]||argv[i+1].startsWith('--')||values[arg]!==undefined)throw new Error(`invalid showcase option: ${arg}`);
    values[arg]=argv[++i];
  }
  if(!values['--tag']||!values['--seed'])throw new Error('--tag and --seed are required');
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,26}$/.test(values['--tag']))throw new Error('--tag must be a 1–27 character safe identifier; generated course codes add a three-character suffix');
  const count=values['--count']===undefined?30:Number(values['--count']);
  if(!Number.isInteger(count)||count<1||count>30)throw new Error('--count must be an integer from 1 through 30');
  if(run&&count!==30)throw new Error('--run requires the complete 30-contest plan; use --count only with dry-run');
  return {tag:values['--tag'],seed:values['--seed'],count,run,resume};
}
function obj(value: unknown): Record<string,unknown>|undefined { return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined; }
function objectArray(value:unknown):Record<string,unknown>[] { return Array.isArray(value)?value.map(obj).filter((item):item is Record<string,unknown>=>Boolean(item)):[]; }
function positive(value:Record<string,unknown>|undefined,key:string):number|undefined { const item=value?.[key];return typeof item==='number'&&Number.isSafeInteger(item)&&item>=0?item:undefined; }
function apiUrl(env: NodeJS.ProcessEnv): URL { const url=new URL(env.OANTUTI_API??'http://127.0.0.1:4301');if(url.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('OANTUTI_API must be a loopback HTTP origin');return url; }
function expectedCourseCodes(tag:string):string[]{return [1,2,3].map(i=>`${tag.toUpperCase()}_C${i}`);}
function expectedTeamNames(tag:string):string[]{return Array.from({length:48},(_,i)=>`${tag}_T${String(i+1).padStart(2,'0')}`);}
export function assertShowcaseManifest(manifest:unknown,expected:{readonly version:1;readonly tag:string;readonly seed:string;readonly digest:string},resume:boolean):void {
  if(manifest===undefined){if(resume)throw new Error('--resume requires an existing matching manifest');return;}
  const current=obj(manifest);
  if(!current||current.version!==expected.version||current.tag!==expected.tag||current.seed!==expected.seed||current.planDigest!==expected.digest||!Array.isArray(current.completed)||!Array.isArray(current.preservedTournamentIds))throw new Error('Existing showcase manifest does not exactly match --tag/--seed/the deterministic plan');
  if(!resume)throw new Error('A showcase manifest already exists; pass --resume to continue without creating duplicates');
}
function expectedTournamentNames(tag:string):string[]{return [...Array.from({length:30},(_,i)=>`${tag}-${String(i+1).padStart(2,'0')}`),`${tag}-PENDING`,`${tag}-REJECTED`,`${tag}-UNRATED`];}
function expectedMapSlugs(tag:string):string[]{return Array.from({length:12},(_,i)=>`${tag.toLowerCase()}-map-${String(i+1).padStart(2,'0')}`);}
function digestPlan(plan:ShowcasePlan):string{
  const bots=Array.from({length:12},(_,slot)=>buildShowcaseBot(slot)).map((bot)=>({variant:bot.variant,language:bot.language,entrypoint:bot.entrypoint,files:bot.files.map((file)=>({path:file.path,digest:createHash('sha256').update(file.contents).digest('hex')}))}));
  const maps=Array.from({length:12},(_,variant)=>buildShowcaseMap(variant,plan.tag));
  return createHash('sha256').update(JSON.stringify({plan,bots,maps})).digest('hex');
}
function inside(child:string,parent:string):boolean { const path=relative(parent,child);return path===''||(!isAbsolute(path)&&path!=='..'&&!path.startsWith(`..${sep}`)); }
async function assertExternalRuntimeRoot(value:string):Promise<string> {
  const requested=resolve(value);const repository=await realpath(resolve(fileURLToPath(new URL('../..',import.meta.url))));
  if(inside(requested,repository))throw new Error('OANTUTI_DEMO_RUNTIME_ROOT must be outside the repository');
  let existing=requested;
  for(;;){
    try{const canonical=await realpath(existing);const candidate=join(canonical,relative(existing,requested));if(inside(candidate,repository))throw new Error('OANTUTI_DEMO_RUNTIME_ROOT must be outside the repository');return requested;}
    catch(error){if(error instanceof Error&&error.message==='OANTUTI_DEMO_RUNTIME_ROOT must be outside the repository')throw error;if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;const parent=dirname(existing);if(parent===existing)throw error;existing=parent;}
  }
}
async function writePrivateJson(path:string,value:unknown,renameFile:typeof rename,chmodFile:typeof chmod):Promise<void> {
  const temporary=`${path}.next`;
  const file=await open(temporary,'w',0o600);
  try{await file.writeFile(JSON.stringify(value,null,2));await file.sync();}finally{await file.close();}
  await chmodFile(temporary,0o600);
  await renameFile(temporary,path);
  await chmodFile(path,0o600);
  const directory=await open(dirname(path),'r');
  try{await directory.sync();}finally{await directory.close();}
}

export async function runShowcaseCli(argv: readonly string[], dependencies: Dependencies = {}): Promise<ShowcaseCliResult> {
  const options=parseShowcaseArgs(argv);const plan=buildShowcasePlan(options.tag,options.seed,options.count);
  if(!options.run)return{mode:'dry-run',plan};
  const env=dependencies.env??process.env;
  const configuredRoot=env.OANTUTI_DEMO_RUNTIME_ROOT;
  if(!configuredRoot)throw new Error('Set OANTUTI_DEMO_RUNTIME_ROOT to a private external data directory');
  const runtimeRoot=await assertExternalRuntimeRoot(configuredRoot);
  if(env.OANTUTI_SHOWCASE_CONFIRM!==options.tag)throw new Error('OANTUTI_SHOWCASE_CONFIRM must exactly equal --tag');
  if(env.OANTUTI_DEV_EXECUTION!=='1')throw new Error('OANTUTI_DEV_EXECUTION=1 required; production executor is forbidden');
  const configuredCookie=env.OANTUTI_SHOWCASE_ADMIN_COOKIE;
  if(!configuredCookie||!/^oantuti_session=[a-f0-9]{64}$/.test(configuredCookie))throw new Error('OANTUTI_SHOWCASE_ADMIN_COOKIE must be a valid existing ADMIN session cookie');
  let cookie: string=configuredCookie;
  const base=apiUrl(env);
  const fetcher=dependencies.fetch??(async(url:string,init?:Parameters<ShowcaseFetch>[1])=>{const response=await fetch(url,init);let body:unknown;try{body=await response.json();}catch{body=null;}return{status:response.status,body,headers:response.headers};});
  const get=async(path:string)=>{const response=await fetcher(new URL(path,base).toString(),{headers:{cookie}});if(response.status<200||response.status>=300&&!(path==='/api/health/ready'&&response.status===503))throw new Error(`Preflight GET ${path} failed: HTTP ${response.status}`);return response.body;};
  const request=async(method:string,path:string,body?:unknown,sessionCookie=cookie,extraHeaders:Record<string,string>={})=>fetcher(new URL(path,base).toString(),{method,headers:{cookie:sessionCookie,...extraHeaders,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const adminPassword=env.OANTUTI_SHOWCASE_ADMIN_PASSWORD;
  if(!adminPassword)throw new Error('OANTUTI_SHOWCASE_ADMIN_PASSWORD is required for real account, lifecycle, and rating workflows');
  let adminUsername:string|undefined;
  const reauthenticateAdmin=async()=>{
    let result=await request('POST','/api/v2/auth/reauth',{password:adminPassword});
    if(result.status===401&&adminUsername){
      const login=await request('POST','/api/v2/auth/login',{username:adminUsername,password:adminPassword});
      const session=login.headers?.get('set-cookie')?.match(/(?:^|,\s*)(oantuti_session=[a-f0-9]{64})/i)?.[1];
      if(login.status<200||login.status>=300||!session)throw new Error(`ADMIN session renewal failed with HTTP ${login.status}`);
      cookie=session;
      result=await request('POST','/api/v2/auth/reauth',{password:adminPassword});
    }
    if(result.status<200||result.status>=300)throw new Error(`ADMIN re-authentication failed with HTTP ${result.status}`);
  };
  const health=obj(await get('/api/health'));
  if(health?.status!=='ok')throw new Error('API liveness preflight failed');
  const ready=obj(await get('/api/health/ready'));
  const checks=Array.isArray(ready?.checks)?ready.checks.map(obj):[];
  const findCheck=(name:string)=>checks.find(item=>item?.name===name);
  const allowedDevWarnings=new Set(['executionGateway','executionPlane','backupFence','workers']);
  if(ready?.productionReady!==false||!['ready','degraded'].includes(String(ready?.status))||!findCheck('database')?.ok||!findCheck('schema')?.ok||!findCheck('objectRoots')?.ok||checks.some(item=>item&&!item.ok&&!allowedDevWarnings.has(String(item.name))))throw new Error('API health/readiness does not match an intact schema-27 development runtime');
  const identity=obj(await get('/api/v2/auth/me'));const user=obj(identity?.user);
  adminUsername=typeof user?.username==='string'?user.username:undefined;
  if(user?.role!=='ADMIN'||identity?.scope!=='FULL'||identity?.authProfile!=='LAN_OFFLINE'||!adminUsername)throw new Error('Showcase seeding requires a FULL LAN_OFFLINE ADMIN with a username');
  const runner=obj(await get('/api/v2/organizer/runner-status'));
  if(runner?.enabled!==true)throw new Error('The development auto-runner is not enabled');
  const mapsEnvelope=obj(await get('/api/v2/maps'));
  const maps=Array.isArray(mapsEnvelope?.maps)?mapsEnvelope.maps.map(obj):[];
  if(!env.PGHOST||!env.PGPORT||!env.PGUSER||!env.PGDATABASE)throw new Error('Explicit PGHOST/PGPORT/PGUSER/PGDATABASE required for read-only preflight');
  const query:ShowcaseQuery=dependencies.db??(async(sql,params=[])=>{const client=new pg.Client({host:env.PGHOST,port:Number(env.PGPORT),user:env.PGUSER,database:env.PGDATABASE,options:'-c default_transaction_read_only=on'});await client.connect();try{const result=await client.query(sql,[...params]);return{rows:result.rows as unknown as readonly Record<string,unknown>[]};}finally{await client.end();}});
  const tournamentEnvelope=obj(await get('/api/v2/tournaments'));
  const tournaments=Array.isArray(tournamentEnvelope?.tournaments)?tournamentEnvelope.tournaments.map(obj):[];
  const current=await query('SELECT current_database() AS name');
  if(current.rows[0]?.name!==env.PGDATABASE)throw new Error('Connected PostgreSQL database does not match PGDATABASE');
  const capacityRows=await query("SELECT value FROM deployment_settings WHERE key='accountCapacity'");
  const capacity=obj(capacityRows.rows[0]?.value)?.limit;
  const userRows=await query('SELECT count(*)::text AS count FROM users');const userCount=Number(userRows.rows[0]?.count??0);
  const courseCodes=expectedCourseCodes(options.tag),teamNames=expectedTeamNames(options.tag),tournamentNames=expectedTournamentNames(options.tag),mapSlugs=expectedMapSlugs(options.tag);
  const courseRows=await query('SELECT code FROM courses WHERE code=ANY($1::text[])',[courseCodes]);
  const teamRows=await query('SELECT name FROM teams WHERE name=ANY($1::text[])',[teamNames]);
  const usernameRows=await query('SELECT username FROM users WHERE username=ANY($1::text[])',[buildShowcaseIdentities(options.tag).map(({username})=>username)]);
  const remainingAccounts=96-usernameRows.rows.length;
  const accountCapacity=typeof capacity==='number'&&Number.isSafeInteger(capacity)?capacity:null;
  if(accountCapacity===null||remainingAccounts<0||accountCapacity-userCount<remainingAccounts)throw new Error(`accountCapacity has room for ${accountCapacity===null?'an invalid amount':accountCapacity-userCount} additional users; ${remainingAccounts} required by this showcase`);
  const tournamentRows=await query('SELECT name FROM tournaments WHERE name=ANY($1::text[])',[tournamentNames]);
  const mapRows=await query('SELECT slug FROM maps WHERE slug=ANY($1::text[])',[mapSlugs]);
  const apiExisting=[...tournaments.map(row=>row?.name),...maps.map(row=>row?.slug)];
  const collisions=[...courseRows.rows,...usernameRows.rows,...teamRows.rows,...tournamentRows.rows,...mapRows.rows].length||apiExisting.some(value=>tournamentNames.includes(String(value))||mapSlugs.includes(String(value)));
  const directory=join(runtimeRoot,'showcases',options.tag);const manifestPath=join(directory,'manifest.json');const credentialsPath=join(directory,'credentials.json');
  const fsRead=dependencies.readFile??readFile,fsWrite=dependencies.writeFile??writeFile,fsMkdir=dependencies.mkdir??mkdir,fsChmod=dependencies.chmod??chmod;
  const digest=digestPlan(plan);
  let priorManifest:Record<string,unknown>|undefined;
  try{priorManifest=obj(JSON.parse(await fsRead(manifestPath,'utf8')));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  assertShowcaseManifest(priorManifest,{version:1,tag:options.tag,seed:options.seed,digest},options.resume);
  const existingTournamentIds=await query('SELECT id::text AS id FROM tournaments WHERE NOT (name=ANY($1::text[]))',[tournamentNames]);
  const existingIds=new Set(existingTournamentIds.rows.map((row)=>String(row.id)).sort());
  const baseline=priorManifest?.preservedTournamentIds;
  if(priorManifest&&(!Array.isArray(baseline)||!baseline.every((value)=>typeof value==='string')))throw new Error('existing manifest lacks a valid protected tournament baseline');
  if(Array.isArray(baseline)&&baseline.some((value)=>!existingIds.has(value)))throw new Error('a preexisting tournament ID is missing from the protected manifest baseline');
  const preservedTournamentIds:string[]=Array.isArray(baseline)?baseline: [...existingIds];
  if(!priorManifest&&collisions)throw new Error('Matching showcase-tag database/API objects exist without the private manifest; refusing possible duplicate provisioning');
  await reauthenticateAdmin();
  await fsMkdir(directory,{recursive:true,mode:0o700});await fsChmod(directory,0o700);
  return withShowcaseLock(join(directory,'.run.lock'),async()=>{
  let manifest:Record<string,unknown>|undefined;
  try{const parsed:unknown=JSON.parse(await fsRead(manifestPath,'utf8'));manifest=obj(parsed);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const digest=digestPlan(plan);
  assertShowcaseManifest(manifest,{version:1,tag:options.tag,seed:options.seed,digest},options.resume);
  if(!manifest&&collisions)throw new Error('Matching showcase-tag database/API objects exist without the private manifest; refusing possible duplicate provisioning');
  if(!manifest){
    await fsMkdir(directory,{recursive:true,mode:0o700});await fsChmod(directory,0o700);
    manifest={version:1,tag:options.tag,seed:options.seed,planDigest:digest,plan,courseIds:[],teamIds:[],mapIds:[],tournamentIds:[],completed:[],pendingContest:null,credentialsFile:'credentials.json',preservedTournamentIds};
    await fsWrite(manifestPath,JSON.stringify(manifest,null,2),{mode:0o600,flag:'wx'});await fsChmod(manifestPath,0o600);
    await fsWrite(credentialsPath,JSON.stringify({version:1,accounts:{}},null,2),{mode:0o600,flag:'wx'});await fsChmod(credentialsPath,0o600);
  }
  const fsRename=dependencies.rename??rename;
  let credentials:ShowcaseCredentials={version:1,accounts:{}};
  try{
    const stored=obj(JSON.parse(await fsRead(credentialsPath,'utf8')));
    if(stored?.version!==1||!obj(stored.accounts))throw new Error('showcase credentials file has an invalid version or account map');
    credentials={version:1,accounts:stored.accounts as ShowcaseCredentials['accounts']};
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const api=async(method:string,path:string,body?:unknown)=>request(method,path,body);
  const persistCredentials=async(next:ShowcaseCredentials)=>{await writePrivateJson(credentialsPath,next,fsRename,fsChmod);credentials=next;};
  const authenticateStudent=async(username:string)=>{
    const account=credentials.accounts[username];
    if(!account?.password)throw new Error(`no private password is stored for ${username}`);
    return authenticateShowcaseStudent({
      api:async(method,path,body,session)=>{const result=await request(method,path,body,session);return{status:result.status,body:result.body,setCookie:result.headers?.get('set-cookie')??undefined};},
      username,password:account.password,previousPassword:account.previousPassword,newPassword:()=>randomBytes(32).toString('base64url'),
      savePasswordIntent:async(password,oldPassword)=>{credentials.accounts[username]={userId:account.userId,password,previousPassword:oldPassword};await persistCredentials(credentials);},
      savePassword:async(password)=>{credentials.accounts[username]={userId:account.userId,password};await persistCredentials(credentials);},
    });
  };
  const checkpoint=async(phase:string,ids:Readonly<Record<string,string>>)=>{
    const previous=obj(manifest?.checkpoints)??{};
    const existing=obj(previous[phase])??{};
    manifest={...manifest,checkpoints:{...previous,[phase]:{...existing,...ids}},lastObservedPhase:phase};
    await writePrivateJson(manifestPath,manifest,fsRename,fsChmod);
  };
  const provisioned=await provisionShowcaseBase({tag:options.tag,api,db:query,credentials,reauthenticateAdmin,persistCredentials,checkpoint});
  manifest={...manifest,courseIds:provisioned.courseIds,teamIds:provisioned.teamIds,mapSlugs:provisioned.mapSlugs,baseProvisioned:true};
  await writePrivateJson(manifestPath,manifest,fsRename,fsChmod);
  const contestApi=async(method:string,path:string,body?:unknown,session?:string,headers:Record<string,string>={})=>request(method,path,body,session??cookie,headers);
  const readCheckpoint=(phase:string,key:string)=>{const value=obj(obj(manifest?.checkpoints)?.[phase])?.[key];return typeof value==='string'?value:undefined;};
  const runAndRecord=async(contest:ShowcasePlan['contests'][number],reviewOutcome:'APPROVE'|'PENDING'|'REJECT'|'UNRATED')=>{
    const result=await runShowcaseContest({tag:options.tag,contest,reviewOutcome,teamIds:provisioned.teamIds,mapSlugs:provisioned.mapSlugs,api:contestApi,db:query,adminCookie:()=>cookie,adminReauthenticate:reauthenticateAdmin,authenticateStudent,checkpoint,readCheckpoint,wait:(ms)=>new Promise<void>((resolve)=>setTimeout(resolve,ms))});
    const completed: string[] = Array.isArray(manifest!.completed)?manifest!.completed.filter((value):value is string=>typeof value==='string'):[];
    const tournamentIds: string[] = Array.isArray(manifest!.tournamentIds)?manifest!.tournamentIds.filter((value):value is string=>typeof value==='string'):[];
    manifest={...manifest!,completed:[...new Set([...completed,contest.name])],tournamentIds:[...new Set([...tournamentIds,result.tournamentId])]};
    await writePrivateJson(manifestPath,manifest,fsRename,fsChmod);
    console.log(`${contest.name}: ${result.completedGames} games, ${result.acceptedResults} accepted, ${result.reviewOutcome} (${result.ratingPublication})`);
  };
  for(const contest of plan.contests)await runAndRecord(contest,'APPROVE');
  const examples=[
    {...plan.contests[0],index:30,name:`${options.tag}-PENDING`,format:'ROUND_ROBIN' as const,cohortIndex:0},
    {...plan.contests[1],index:31,name:`${options.tag}-REJECTED`,format:'ELO_ARENA' as const,cohortIndex:1},
    {...plan.contests[2],index:32,name:`${options.tag}-UNRATED`,format:'SINGLE_ELIMINATION' as const,cohortIndex:2,rated:false},
  ];
  await runAndRecord(examples[0],'PENDING');
  await runAndRecord(examples[1],'REJECT');
  await runAndRecord(examples[2],'UNRATED');
  const report=await query(`SELECT t.id,t.name,t.is_rated,t.state,c.review_state,c.desired_included,
    (SELECT count(DISTINCT e.team_id)::int FROM tournament_entries e WHERE e.tournament_id=t.id) AS teams,
    (SELECT count(g.id)::int FROM games g JOIN encounters e ON e.id=g.encounter_id WHERE e.tournament_id=t.id) AS games,
    (SELECT count(ar.game_id)::int FROM accepted_results ar JOIN games g ON g.id=ar.game_id JOIN encounters e ON e.id=g.encounter_id WHERE e.tournament_id=t.id) AS accepted
    FROM tournaments t LEFT JOIN global_rating_contests c ON c.tournament_id=t.id WHERE t.name=ANY($1::text[])`,[expectedTournamentNames(options.tag)]);
  if(report.rows.length!==33)throw new Error(`showcase tournament count mismatch: ${report.rows.length}/33`);
  const contestsByName=new Map(report.rows.map((row)=>[String(row.name),row]));
  for(const contest of plan.contests){
    const row=contestsByName.get(contest.name);
    if(!row||row.is_rated!==true||row.state!=='FINALIZED'||row.review_state!=='APPROVED'||row.desired_included!==true||Number(row.teams)!==4||Number(row.games)<1||Number(row.accepted)<1)throw new Error(`approved Rated evidence is incomplete for ${contest.name}`);
  }
  const pending=contestsByName.get(`${options.tag}-PENDING`),rejected=contestsByName.get(`${options.tag}-REJECTED`),unrated=contestsByName.get(`${options.tag}-UNRATED`);
  if(!pending||pending.review_state!=='PENDING'||pending.desired_included!==false)throw new Error('Pending example changed from its required unpublished state');
  if(!rejected||rejected.review_state!=='REJECTED'||rejected.desired_included!==false)throw new Error('Rejected example changed from its required unpublished state');
  if(!unrated||unrated.is_rated!==false||unrated.review_state!==null)throw new Error('Unrated example unexpectedly entered global rating review');
  const leaderboard=obj(await get('/api/v2/ratings/teams?limit=100'));
  const ratingRows=objectArray(leaderboard?.rows);
  const showcaseRows=ratingRows.filter((row)=>typeof row.name==='string'&&row.name.startsWith(`${options.tag}_T`));
  if(obj(leaderboard?.publication)?.updating!==false||showcaseRows.length!==48)throw new Error(`public leaderboard incomplete: ${showcaseRows.length}/48 showcase rows or publication is updating`);
  const ranks=new Set<number>(),values=new Set<number>();
  for(const row of showcaseRows){const rating=obj(row.rating),rank=positive(row,'rank'),value=positive(rating,'rating'),ratedCount=positive(rating,'ratedContests');if(rank===undefined||value===undefined||ratedCount===undefined||ratedCount<1)throw new Error('public leaderboard contains an unrated or underplayed showcase team');ranks.add(rank);values.add(value);}
  if(ranks.size<3||values.size<4)throw new Error(`rating outcomes are not sufficiently diverse: ${ranks.size} ranks, ${values.size} ratings`);
  const preservedAfter=await query('SELECT id::text AS id FROM tournaments WHERE id=ANY($1::uuid[])',[preservedTournamentIds]);
  if(preservedAfter.rows.length!==preservedTournamentIds.length)throw new Error('existing tournament inventory changed during showcase seeding');
  const web=(env.OANTUTI_WEB??'http://127.0.0.1:4300').replace(/\/$/,'');
  const topTeam=showcaseRows[0];
  console.log(`showcase verified: 48 teams, 30 approved Rated, 1 PENDING, 1 REJECTED, 1 Unrated; ${ranks.size} ranks`);
  console.log(`public rankings: ${web}/rankings`);
  if(topTeam)console.log(`team profile: ${web}/teams/${String(topTeam.teamId)}`);
  const firstTournament=contestsByName.get(plan.contests[0].name);
  if(firstTournament)console.log(`first contest: ${web}/tournaments/${String(firstTournament.id)}`);
  console.log(`ADMIN rating review: ${web}/organizer`);
  return{mode:'complete',plan,manifestPath};
  });
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  runShowcaseCli(process.argv.slice(2)).then(result=>console.log(JSON.stringify({mode:result.mode,tag:result.plan.tag,contests:result.plan.contests.length,manifest:result.manifestPath??null}))).catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
}
