import { describe, expect, it } from 'vitest';
import { provisionShowcaseBase, type ShowcaseProvisionApi, type ShowcaseProvisionDb } from '../deploy/linux/demo-showcase-provision.js';
type State = { courses: Map<string,{id:string;code:string;name:string}>; users: Map<string,{id:string;username:string;display_name:string;role:string;activation_method:string}>; teams: Map<string,{id:string;name:string;captain_user_id:string;course_code:string;members:string[];memberId?:string}>; maps: Map<string,{slug:string;display_name:string;descriptor:unknown}>; passwordResets: number };
function fakeWorld(): { state: State; api: ShowcaseProvisionApi; db: ShowcaseProvisionDb } {
  const state:State={courses:new Map(),users:new Map(),teams:new Map(),maps:new Map(),passwordResets:0};let id=0;
  const api:ShowcaseProvisionApi=async(method,path,body)=>{
    const value=body as Record<string,unknown>;
    if(method==='POST'&&path.startsWith('/api/v2/organizer/accounts/')&&path.endsWith('/reset-password')){state.passwordResets++;const target=decodeURIComponent(path.split('/')[5]);const user=[...state.users.values()].find(row=>row.id===target)!;return{status:200,body:{userId:user.id,username:user.username,temporaryPassword:`reset-${user.id}`}};}
    if(method==='POST'&&path==='/api/v2/organizer/courses'){const course={id:`c${++id}`,code:String(value.code),name:String(value.name)};state.courses.set(course.code,course);return{status:201,body:course};}
    if(method==='POST'&&path==='/api/v2/organizer/accounts/provision-lan'){const created=(value.users as {username:string;displayName:string}[]).map(user=>{const userId=`u${++id}`;const entry={userId,username:user.username,displayName:user.displayName,temporaryPassword:`pw-${id}`};state.users.set(entry.username,{id:userId,username:entry.username,display_name:entry.displayName,role:'STUDENT',activation_method:'ADMIN_ISSUED'});return entry;});return{status:200,body:{created}};}
    if(method==='POST'&&path==='/api/v2/organizer/teams'){const captain=state.users.get(String(value.captainUsername))!;const team={id:`t${++id}`,name:String(value.name),captain_user_id:captain.id,course_code:String(value.courseCode),members:[captain.id]};state.teams.set(team.name,team);return{status:201,body:{team:{id:team.id,name:team.name,captainUserId:captain.id}}};}
    if(method==='POST'&&path.includes('/api/v2/organizer/teams/')&&path.endsWith('/members')){const team=[...state.teams.values()].find(row=>path.includes(row.id))!;team.memberId=String(value.userId);team.members.push(String(value.userId));return{status:200,body:{id:team.id}};}
    if(method==='POST'&&path==='/api/v2/organizer/maps'){state.maps.set(String(value.slug),{slug:String(value.slug),display_name:String(value.displayName),descriptor:value.descriptor});return{status:201,body:{slug:value.slug,id:`m${++id}`}};}
    throw new Error(`unexpected API ${method} ${path}`);
  };
  const db:ShowcaseProvisionDb=async(sql,params=[])=>{
    if(sql.includes('FROM courses'))return{rows:[...state.courses.values()].filter(row=>(params[0] as string[]).includes(row.code))};
    if(sql.includes('FROM users'))return{rows:[...state.users.values()].filter(row=>(params[0] as string[]).includes(row.username))};
    if(sql.includes('FROM teams'))return{rows:[...state.teams.values()].filter(row=>(params[0] as string[]).includes(row.name))};
    if(sql.includes('FROM maps'))return{rows:[...state.maps.values()].filter(row=>(params[0] as string[]).includes(row.slug))};
    return{rows:[]};
  };
  return{state,api,db};
}

describe('API-backed showcase base provisioning',()=>{
  it('creates the three cohorts, 48 two-student teams, and twelve maps through product APIs',async()=>{
    const world=fakeWorld();const result=await provisionShowcaseBase({tag:'SHOWCASE',api:world.api,db:world.db,credentials:{version:1,accounts:{}},reauthenticateAdmin:async()=>undefined,persistCredentials:async()=>undefined,checkpoint:async()=>undefined});
    expect(world.state.courses.size).toBe(3);expect(world.state.users.size).toBe(96);expect(world.state.teams.size).toBe(48);expect(world.state.maps.size).toBe(12);
    expect([...world.state.teams.values()].every(team=>Boolean(team.memberId))).toBe(true);
    expect(Object.keys(result.credentials.accounts)).toHaveLength(96);expect(result.teamIds).toHaveLength(48);expect(result.mapSlugs).toHaveLength(12);
  });
  it('reconciles an ambiguous response and safely resumes without duplicate accounts',async()=>{
    const world=fakeWorld();let loseResponse=true;
    const api:ShowcaseProvisionApi=async(method,path,body)=>{const result=await world.api(method,path,body);if(loseResponse&&method==='POST'&&path==='/api/v2/organizer/accounts/provision-lan'){loseResponse=false;throw new Error('connection reset after commit');}return result;};
    const options={tag:'SHOWCASE',api,db:world.db,credentials:{version:1 as const,accounts:{}},reauthenticateAdmin:async()=>undefined,persistCredentials:async()=>undefined,checkpoint:async()=>undefined};
    const first=await provisionShowcaseBase(options);
    expect(world.state.users.size).toBe(96);expect(Object.keys(first.credentials.accounts)).toHaveLength(96);expect(world.state.passwordResets).toBe(96);
    const second=await provisionShowcaseBase({...options,api:world.api,credentials:first.credentials});
    expect(world.state.users.size).toBe(96);expect(world.state.passwordResets).toBe(96);expect(second.teamIds).toEqual(first.teamIds);
  });
  it('rejects tag-owned username conflicts before creating any courses',async()=>{
    const world=fakeWorld();world.state.users.set('showcase_01a',{id:'foreign',username:'showcase_01a',display_name:'Unrelated account',role:'STUDENT',activation_method:'ADMIN_ISSUED'});
    await expect(provisionShowcaseBase({tag:'SHOWCASE',api:world.api,db:world.db,credentials:{version:1,accounts:{}},reauthenticateAdmin:async()=>undefined,persistCredentials:async()=>undefined,checkpoint:async()=>undefined})).rejects.toThrow(/not a matching showcase-owned/);
    expect(world.state.courses.size).toBe(0);
  });
});
