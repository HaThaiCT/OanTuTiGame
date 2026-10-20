import { createHash } from 'node:crypto';
import { buildShowcaseBot, buildShowcaseMap, buildShowcaseZip } from './demo-showcase-assets.js';
import type { ShowcaseContestPlan } from './demo-showcase-plan.js';

export type ShowcaseContestApi = (method: string, path: string, body?: unknown, cookie?: string, headers?: Record<string,string>) => Promise<{ readonly status: number; readonly body: unknown }>;
export type ShowcaseContestDb = (sql: string, params?: readonly unknown[]) => Promise<{ readonly rows: readonly Record<string,unknown>[] }>;
export interface ShowcaseContestInput {
  readonly tag: string;
  readonly contest: ShowcaseContestPlan;
  readonly reviewOutcome?: 'APPROVE' | 'PENDING' | 'REJECT' | 'UNRATED';
  readonly teamIds: readonly string[];
  readonly mapSlugs: readonly string[];
  readonly api: ShowcaseContestApi;
  readonly db: ShowcaseContestDb;
  readonly adminCookie: () => string;
  readonly adminReauthenticate: () => Promise<void>;
  readonly authenticateStudent: (username: string) => Promise<{ readonly cookie: string }>;
  readonly checkpoint: (phase: string, values: Readonly<Record<string,string>>) => Promise<void>;
  readonly readCheckpoint: (phase: string, key: string) => string | undefined;
  readonly wait: (milliseconds: number) => Promise<void>;
}
export interface ShowcaseContestResult { readonly tournamentId: string; readonly completedGames: number; readonly acceptedResults: number; readonly ratingPublication: string; readonly reviewOutcome: 'APPROVE' | 'PENDING' | 'REJECT' | 'UNRATED' }

function object(value: unknown): Record<string,unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : undefined; }
function array(record: Record<string,unknown> | undefined, key: string): unknown[] { return Array.isArray(record?.[key]) ? record[key] as unknown[] : []; }
function string(record: Record<string,unknown> | undefined,key:string):string|undefined { return typeof record?.[key]==='string' ? record[key] as string : undefined; }
function positive(record: Record<string,unknown> | undefined,key:string):number|undefined { return typeof record?.[key]==='number'&&Number.isSafeInteger(record[key]) ? record[key] as number : undefined; }
function objectArray(value: unknown): Record<string,unknown>[] { return Array.isArray(value) ? value.map(object).filter((item):item is Record<string,unknown>=>Boolean(item)) : []; }
async function call(api:ShowcaseContestApi,method:string,path:string,body?:unknown,cookie?:string,headers:Record<string,string>={}):Promise<unknown> {
  const response=await api(method,path,body,cookie,headers);
  if(response.status<200||response.status>=300)throw new Error(`${method} ${path} returned HTTP ${response.status}`);
  return response.body;
}
async function waitUntil<T>(input:ShowcaseContestInput,label:string,timeoutMs:number,probe:()=>Promise<T|null>):Promise<T> {
  const end=Date.now()+timeoutMs;
  while(Date.now()<end){const value=await probe();if(value!==null)return value;await input.wait(2_000);}
  throw new Error(`timed out waiting for ${label}`);
}
async function tournament(input:ShowcaseContestInput,name:string):Promise<Record<string,unknown>|undefined> {
  const rows=await input.db('SELECT t.id,t.name,t.state,t.version,t.format,t.is_rated,c.code AS course_code FROM tournaments t JOIN courses c ON c.id=t.course_id WHERE t.name=$1',[name]);
  return object(rows.rows[0]);
}
async function state(input:ShowcaseContestInput,id:string):Promise<string> {
  const row=await input.db('SELECT state FROM tournaments WHERE id=$1',[id]);
  const value=string(object(row.rows[0]),'state');
  if(!value)throw new Error(`tournament state disappeared: ${id}`);
  return value;
}
async function submitAndWait(input:ShowcaseContestInput,tournamentId:string,teamId:string,teamSlot:number):Promise<void> {
  const identity=`${input.tag.toLowerCase()}_${String(teamSlot+1).padStart(2,'0')}a`;
  const zip=buildShowcaseZip(teamSlot);
  const latest=async()=>{
    const result=await input.db('SELECT id,status,language,entrypoint FROM submissions WHERE tournament_id=$1 AND team_id=$2 ORDER BY receipt_ordinal DESC LIMIT 1',[tournamentId,teamId]);
    return object(result.rows[0]);
  };
  let submission=await latest();
  if(submission&&(['REJECTED','CANCELLED'] as string[]).includes(String(submission.status)))throw new Error(`showcase build ${identity} is ${String(submission.status)}; do not retry an in-flight or rejected receipt`);
  if(!submission){
    const tournamentState=await state(input,tournamentId);
    if(tournamentState!=='REGISTRATION_OPEN')throw new Error(`cannot create a missing submission after registration closed (${tournamentState})`);
    const session=await input.authenticateStudent(identity);
    const bot=buildShowcaseBot(teamSlot);
    if(bot.language!==zip.language||bot.entrypoint!==zip.entrypoint)throw new Error(`showcase asset variant mismatch for ${identity}`);
    await call(input.api,'POST',`/api/v2/tournaments/${tournamentId}/submissions`,{teamId,language:zip.language,entrypoint:zip.entrypoint,zipBase64:zip.zipBuffer.toString('base64')},session.cookie);
  }
  submission=await waitUntil(input,`READY build ${identity}`,180_000,async()=>{
    const current=await latest();
    if(!current)return null;
    if(current.status==='REJECTED'||current.status==='CANCELLED')throw new Error(`showcase build ${identity} is ${String(current.status)}`);
    return current.status==='READY'?current:null;
  });
  if(submission.language!==zip.language||submission.entrypoint!==zip.entrypoint)throw new Error(`resumed submission for ${identity} does not match the deterministic Bot variant`);
}

async function ensureGamesSealed(input:ShowcaseContestInput,tournamentId:string):Promise<{completed:number;accepted:number}> {
  const row=(await input.db(`SELECT
    (SELECT count(*)::int FROM games g JOIN encounters e ON e.id=g.encounter_id WHERE e.tournament_id=$1) AS total,
    (SELECT count(*)::int FROM games g JOIN encounters e ON e.id=g.encounter_id WHERE e.tournament_id=$1 AND g.status='COMPLETED') AS completed,
    (SELECT count(*)::int FROM games g JOIN encounters e ON e.id=g.encounter_id WHERE e.tournament_id=$1 AND g.status IN ('PENDING','RUNNING')) AS nonterminal,
    (SELECT count(*)::int FROM games g JOIN encounters e ON e.id=g.encounter_id LEFT JOIN accepted_results ar ON ar.game_id=g.id WHERE e.tournament_id=$1 AND g.status='COMPLETED' AND ar.game_id IS NULL) AS missing_accepted,
    (SELECT count(*)::int FROM tournament_rounds WHERE tournament_id=$1 AND sealed_at IS NULL) AS unsealed,
    (SELECT count(*)::int FROM accepted_results ar JOIN games g ON g.id=ar.game_id JOIN encounters e ON e.id=g.encounter_id WHERE e.tournament_id=$1) AS accepted`,[tournamentId])).rows[0];
  const result=object(row);
  const total=positive(result,'total')??0,completed=positive(result,'completed')??0,nonterminal=positive(result,'nonterminal')??0,missing=positive(result,'missing_accepted')??0,unsealed=positive(result,'unsealed')??0,accepted=positive(result,'accepted')??0;
  if(total<1||completed!==total||nonterminal!==0||missing!==0||unsealed!==0||accepted!==completed)throw new Error(`contest evidence is incomplete: games=${completed}/${total}, accepted=${accepted}, nonterminal=${nonterminal}, unsealed=${unsealed}`);
  return{completed,accepted};
}

export async function runShowcaseContest(input:ShowcaseContestInput):Promise<ShowcaseContestResult> {
  const reviewOutcome=input.reviewOutcome??'APPROVE';
  const rated=reviewOutcome!=='UNRATED';
  if(input.contest.rated!==rated)throw new Error(`contest ${input.contest.name} Rated flag conflicts with requested review outcome`);
  const {tag,contest,api,db}=input;
  const beforePublication=reviewOutcome==='APPROVE'?undefined:object(object(await call(api,'GET','/api/v2/ratings/teams'))?.publication);
  if(input.teamIds.length!==48||input.mapSlugs.length!==12)throw new Error('showcase base inventory must contain 48 teams and 12 maps');
  const courseCode=`${tag}_C${contest.cohortIndex+1}`;
  const existing=await tournament(input,contest.name);
  let tournamentId:string;
  let currentState:string;
  if(existing){
    if(existing.format!==contest.format||existing.is_rated!==rated||existing.course_code!==courseCode)throw new Error(`existing tournament ${contest.name} does not match the deterministic plan`);
    tournamentId=string(existing,'id')!;currentState=string(existing,'state')!;
  }else{
    const body=object(await call(api,'POST','/api/v2/organizer/tournaments',{courseCode,name:contest.name,format:contest.format,maxTeams:4,minTeamSize:2,maxTeamSize:2,isRated:rated},input.adminCookie()));
    const row=object(body?.tournament);tournamentId=string(row,'id')??string(body,'id')??'';
    if(!tournamentId)throw new Error(`tournament ${contest.name} creation returned no id`);
    currentState=await state(input,tournamentId);
  }
  const roundCount=async()=>Number((await db('SELECT count(*)::text AS count FROM tournament_rounds WHERE tournament_id=$1',[tournamentId])).rows[0]?.count??0);
  if(currentState==='RUNNING'&&await roundCount()===0)throw new Error(`tournament ${contest.name} is RUNNING with no round-one schedule; stop and inspect the supported recovery path`);

  const poolSize=contest.format==='SINGLE_ELIMINATION'||contest.format==='SWISS_PLAYOFF'?4:1;
  const mapStart=(contest.index*3)%input.mapSlugs.length;
  const requiredMaps=Array.from({length:poolSize},(_,offset)=>input.mapSlugs[(mapStart+offset)%input.mapSlugs.length]);
  const currentPoolRows=await db('SELECT m.slug FROM tournament_map_pool p JOIN maps m ON m.id=p.map_id WHERE p.tournament_id=$1',[tournamentId]);
  const currentPool=new Set(currentPoolRows.rows.map((row)=>String(row.slug)));
  if(currentState==='DRAFT'){
    const pool=object(await call(api,'GET',`/api/v2/organizer/tournaments/${tournamentId}/map-pool`,undefined,input.adminCookie()));
    for(const entry of objectArray(pool?.pool)){const slug=string(entry,'slug');if(slug)currentPool.add(slug);}
    for(const slug of requiredMaps)if(!currentPool.has(slug)){await call(api,'POST',`/api/v2/organizer/tournaments/${tournamentId}/map-pool`,{slug},input.adminCookie());currentPool.add(slug);}
    const commitmentRows=await db('SELECT m.slug FROM tournament_map_commitments c JOIN maps m ON m.id=c.map_id WHERE c.tournament_id=$1',[tournamentId]);
    const committed=string(object(commitmentRows.rows[0]),'slug');
    if(committed&&committed!==requiredMaps[0])throw new Error(`tournament ${contest.name} has a conflicting map commitment`);
    if(!committed)await call(api,'POST',`/api/v2/organizer/tournaments/${tournamentId}/map-commitment`,{slug:requiredMaps[0]},input.adminCookie());
    if(requiredMaps.some((slug)=>!currentPool.has(slug)))throw new Error(`tournament ${contest.name} map pool is incomplete`);
    await input.adminReauthenticate();
    await call(api,'POST',`/api/v2/organizer/tournaments/${tournamentId}/grace`,{minutes:0},input.adminCookie());
    await call(api,'POST',`/api/v2/organizer/tournaments/${tournamentId}/publish`,{},input.adminCookie());
    await input.checkpoint('TOURNAMENT_CREATED',{[contest.name]:tournamentId});
    currentState=await state(input,tournamentId);
  }else if(currentState==='PUBLISHED'||currentState==='REGISTRATION_OPEN'||currentState==='VALIDATING_SUBMISSIONS'||currentState==='REGISTRATION_CLOSED'||currentState==='LOCKED'||currentState==='READY_TO_START'||currentState==='RUNNING'||currentState==='PROVISIONAL'||currentState==='FINALIZED'||currentState==='ARCHIVED'){
    if(requiredMaps.some((slug)=>!currentPool.has(slug))||currentPool.size!==requiredMaps.length)throw new Error(`resumed tournament ${contest.name} has a different map pool`);
    const commitmentRows=await db('SELECT m.slug FROM tournament_map_commitments c JOIN maps m ON m.id=c.map_id WHERE c.tournament_id=$1',[tournamentId]);
    if(commitmentRows.rows[0]?.slug!==requiredMaps[0])throw new Error(`resumed tournament ${contest.name} has a different map commitment`);
  }else throw new Error(`tournament ${contest.name} is in unsupported state ${currentState}`);
  if(currentState==='PUBLISHED'){
    await call(api,'POST',`/api/v2/organizer/tournaments/${tournamentId}/open-registration`,{},input.adminCookie());
    currentState=await state(input,tournamentId);
  }
  const entries=async()=>objectArray(await call(api,'GET',`/api/v2/tournaments/${tournamentId}/entries`,undefined,input.adminCookie()));
  if(currentState==='REGISTRATION_OPEN'){
    const admitted=new Set((await entries()).map((entry)=>string(entry,'teamId')).filter((value):value is string=>Boolean(value)));
    for(const slot of contest.teamSlots){const teamId=input.teamIds[slot];if(!admitted.has(teamId)){await call(api,'POST',`/api/v2/organizer/tournaments/${tournamentId}/enroll`,{teamId},input.adminCookie());admitted.add(teamId);}}
    for(const slot of contest.teamSlots)await submitAndWait(input,tournamentId,input.teamIds[slot],slot);
    await input.adminReauthenticate();
    await call(api,'POST',`/api/v2/organizer/tournaments/${tournamentId}/close-registration`,{},input.adminCookie());
    currentState=await state(input,tournamentId);
  }
  if(currentState==='VALIDATING_SUBMISSIONS'||currentState==='REGISTRATION_CLOSED'){
    await waitUntil(input,`all selected builds READY for ${contest.name}`,180_000,async()=>{
      for(const slot of contest.teamSlots){
        const rows=await db('SELECT status FROM submissions WHERE tournament_id=$1 AND team_id=$2 ORDER BY receipt_ordinal DESC LIMIT 1',[tournamentId,input.teamIds[slot]]);
        const status=String(rows.rows[0]?.status??'');
        if(status==='REJECTED'||status==='CANCELLED')throw new Error(`contest ${contest.name} has a ${status} submission for team slot ${slot}`);
        if(status!=='READY')return null;
      }
      return true;
    });
    await call(api,'POST',`/api/v2/organizer/tournaments/${tournamentId}/lock`,{},input.adminCookie());
    currentState=await state(input,tournamentId);
  }
  if(currentState==='READY_TO_START'||currentState==='LOCKED'){
    await input.adminReauthenticate();
    await call(api,'POST',`/api/v2/organizer/tournaments/${tournamentId}/start`,{mapSlug:requiredMaps[0]},input.adminCookie());
    currentState=await state(input,tournamentId);
    if(currentState==='RUNNING'&&await roundCount()===0)throw new Error(`tournament ${contest.name} is RUNNING with no round-one schedule; stop and inspect the supported recovery path`);
  }
  if(currentState==='RUNNING'||currentState==='PROVISIONAL'){
    await input.adminReauthenticate();
    await call(api,'POST',`/api/v2/organizer/tournaments/${tournamentId}/appeal-window`,{minutes:0},input.adminCookie());
  }
  if(currentState==='RUNNING'){
    currentState=await waitUntil(input,`PROVISIONAL tournament ${contest.name}`,30*60_000,async()=>{
      const observed=await state(input,tournamentId);
      if(observed==='CANCELLED'||observed==='PAUSED')throw new Error(`contest ${contest.name} stopped in ${observed}`);
      return observed==='PROVISIONAL'||observed==='FINALIZED'?observed:null;
    });
  }
  if(currentState==='PROVISIONAL'){
    await ensureGamesSealed(input,tournamentId);
    await input.adminReauthenticate();
    await call(api,'POST',`/api/v2/organizer/tournaments/${tournamentId}/finalize`,{},input.adminCookie());
    currentState=await state(input,tournamentId);
  }
  if(currentState!=='FINALIZED'&&currentState!=='ARCHIVED')throw new Error(`contest ${contest.name} reached unexpected state ${currentState}`);
  const evidence=await ensureGamesSealed(input,tournamentId);
  const publicationPath='/api/v2/ratings/teams';
  const before=beforePublication;
  const assertUnchanged=async()=>{
    const after=object(object(await call(api,'GET',publicationPath))?.publication);
    if(!before||!after||before.generationId!==after.generationId||before.activeRevision!==after.activeRevision||before.desiredRevision!==after.desiredRevision)throw new Error(`${contest.name} unexpectedly changed the public rating generation`);
    return typeof after.generationId==='string'?after.generationId:null;
  };
  if(!rated){
    const changes=object(await call(api,'GET',`/api/v2/tournaments/${tournamentId}/rating-changes`));
    if(changes?.isRated!==false||changes.reviewState!=='UNRATED'||array(changes,'changes').length!==0)throw new Error(`Unrated comparison ${contest.name} exposes unexpected rating changes`);
    const generation=await assertUnchanged();
    await input.checkpoint('UNRATED_VERIFIED',{[contest.name]:tournamentId});
    return{tournamentId,completedGames:evidence.completed,acceptedResults:evidence.accepted,ratingPublication:generation??'none',reviewOutcome};
  }
  const reviewPath=`/api/v2/organizer/tournaments/${tournamentId}/rating-review`;
  let review=object(await call(api,'GET',reviewPath,undefined,input.adminCookie()));
  if(review?.isRated!==true)throw new Error(`contest ${contest.name} is not Rated in the review service`);
  const intentKey=`${tag}:${contest.index}`;
  if(reviewOutcome==='PENDING'){
    if(review.status!=='PENDING'||review.updating===true||typeof review.previewDigest!=='string'||!Array.isArray(review.changes)||review.changes.length!==4)throw new Error(`Pending review example ${contest.name} is not in a valid untouched PENDING state`);
    const generation=await assertUnchanged();
    await input.checkpoint('PENDING_REVIEW_VERIFIED',{[contest.name]:tournamentId});
    return{tournamentId,completedGames:evidence.completed,acceptedResults:evidence.accepted,ratingPublication:generation??'none',reviewOutcome};
  }
  if(reviewOutcome==='REJECT'){
    if(review.status==='PENDING'){
      const sourceDigest=string(review,'sourceDigest');const expectedVersion=positive(review,'tournamentVersion');
      if(!sourceDigest||expectedVersion===undefined||review.updating===true)throw new Error(`rejection preview for ${contest.name} is incomplete`);
      const stored=input.readCheckpoint('REJECTION_INTENT',intentKey);
      let intent:Record<string,unknown>|undefined;
      if(stored){try{intent=object(JSON.parse(stored));}catch{throw new Error(`invalid saved rejection intent for ${contest.name}`);}}
      if(!intent){intent={expectedVersion,reason:`Showcase review example ${contest.name}: rejected by design`,idempotencyKey:createHash('sha256').update(`${tag}:${contest.index}:REJECT:${sourceDigest}`).digest('hex')};await input.checkpoint('REJECTION_INTENT',{[intentKey]:JSON.stringify(intent)});}
      await input.adminReauthenticate();
      await call(api,'POST',`/api/v2/organizer/tournaments/${tournamentId}/rating-reject`,{reason:intent.reason,expectedVersion:intent.expectedVersion},input.adminCookie(),{'idempotency-key':String(intent.idempotencyKey)});
    }else if(review.status!=='REJECTED')throw new Error(`rejection example ${contest.name} has unexpected status ${String(review.status)}`);
    review=await waitUntil(input,`rejected review for ${contest.name}`,60_000,async()=>{
      const current=object(await call(api,'GET',reviewPath,undefined,input.adminCookie()));
      return current?.status==='REJECTED'&&current.updating===false?current:null;
    });
    const generation=await assertUnchanged();
    await input.checkpoint('REJECTED_REVIEW_VERIFIED',{[contest.name]:tournamentId});
    return{tournamentId,completedGames:evidence.completed,acceptedResults:evidence.accepted,ratingPublication:generation??'none',reviewOutcome};
  }
  let intent:Record<string,unknown>|undefined;
  const storedIntent=input.readCheckpoint('APPROVAL_INTENT',intentKey);
  if(storedIntent){try{intent=object(JSON.parse(storedIntent));}catch{throw new Error(`invalid saved approval intent for ${contest.name}`);}}
  if(review.status==='PENDING'){
    if(review.updating===true)throw new Error(`rating publication is already updating before ${contest.name}`);
    if(!intent){
      const previewDigest=string(review,'previewDigest');
      const generationId=review.generationId===null?null:string(review,'generationId');
      const expectedVersion=positive(review,'tournamentVersion');
      const sourceDigest=string(review,'sourceDigest');
      if(!previewDigest||!sourceDigest||expectedVersion===undefined||!Array.isArray(review.changes)||review.changes.length!==4)throw new Error(`rating preview for ${contest.name} is incomplete`);
      const idempotencyKey=createHash('sha256').update(`${tag}:${contest.index}:${sourceDigest}`).digest('hex');
      intent={previewDigest,generationId,expectedVersion,idempotencyKey};
      await input.checkpoint('APPROVAL_INTENT',{[intentKey]:JSON.stringify(intent)});
    }
    await input.adminReauthenticate();
    await call(api,'POST',`/api/v2/organizer/tournaments/${tournamentId}/rating-approve`,{previewDigest:intent.previewDigest,generationId:intent.generationId,expectedVersion:intent.expectedVersion},input.adminCookie(),{'idempotency-key':String(intent.idempotencyKey)});
    await input.checkpoint('APPROVAL_SUBMITTED',{[intentKey]:tournamentId});
  }else if(review.status!=='APPROVED'){
    throw new Error(`contest ${contest.name} rating review is ${String(review.status)}; refusing to manufacture an approval`);
  }
  review=await waitUntil(input,`published rating generation for ${contest.name}`,10*60_000,async()=>{
    const current=object(await call(api,'GET',reviewPath,undefined,input.adminCookie()));
    if(current?.status==='REJECTED'||current?.status==='BLOCKED')throw new Error(`rating review for ${contest.name} became ${String(current.status)}`);
    return current?.status==='APPROVED'&&current.updating===false?current:null;
  });
  const publicChanges=object(await call(api,'GET',`/api/v2/tournaments/${tournamentId}/rating-changes`));
  if(publicChanges?.reviewState!=='APPROVED'||array(publicChanges,'changes').length!==4)throw new Error(`public rating changes for ${contest.name} do not match the approved review`);
  const publication=string(review,'generationId');
  await input.checkpoint('RATING_APPROVED',{[intentKey]:tournamentId});
  return{tournamentId,completedGames:evidence.completed,acceptedResults:evidence.accepted,ratingPublication:publication??'active',reviewOutcome};
}
