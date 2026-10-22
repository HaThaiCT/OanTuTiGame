import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Actor, CommandContext } from '@oantuti/protocol';
import { PostgresDatabase } from '../src/persistence/db.js';
import { TeamService } from '../src/teams/service.js';
import { TournamentEntryCodeService } from '../src/tournaments/entry-code-service.js';
import { TournamentAdmissionService } from '../src/tournaments/admission-service.js';
import { TournamentRegistrationService } from '../src/tournaments/registration-service.js';
import { hashToken } from '../src/identity/crypto.js';

describe('ONLINE team lifecycle', () => {
  const db = new PostgresDatabase();
  const teams = new TeamService(db, 'ONLINE');
  const registrations = new TournamentRegistrationService(db, 'ONLINE');
  const codes = new TournamentEntryCodeService(db, 'ONLINE', registrations);
  const course = randomUUID(), tournament = randomUUID(), otherTournament = randomUUID();
  const students = Array.from({length: 17}, () => randomUUID());
  const actor = (index: number): Actor => ({userId: students[index], username: `ot_${students[index]}`, role:'STUDENT', scope:'FULL', teamIds:[]});
  let teamId: string;
  beforeAll(async () => {
    await db.query("INSERT INTO courses(id,code,name) VALUES($1,$2,'Online teams')", [course, `OT_${course}`]);
    for (const id of students) await db.query("INSERT INTO users(id,username,display_name,password_hash,role,activation_method,email,email_verified_at) VALUES($1,$2,'Student','hash','STUDENT','SELF_REGISTER',$3,now())", [id,`ot_${id}`,`${id}@example.test`]);
    await db.query("INSERT INTO tournaments(id,course_id,name,format,state,max_teams,min_team_size,max_team_size) VALUES($1,$2,'Online cup','ROUND_ROBIN','REGISTRATION_OPEN',8,1,2)", [tournament,course]);
    await db.query("INSERT INTO tournaments(id,course_id,name,format,state,max_teams,min_team_size,max_team_size) VALUES($1,$2,'Online cup two','ROUND_ROBIN','REGISTRATION_OPEN',8,1,2)", [otherTournament,course]);
  });
  afterAll(async () => {
    await db.query('DELETE FROM entry_code_attempts WHERE key_hash=ANY($1::text[])',[students.flatMap(id=>[hashToken('entry-code:actor:'+id),hashToken('entry-code:ip:'+id)]).concat(hashToken('entry-code:ip:unknown'))]);
    await db.query('DELETE FROM audit_events WHERE actor_user_id=ANY($1::uuid[])',[students]);
    await db.query('DELETE FROM team_invitations WHERE tournament_id=ANY($1::uuid[])',[[tournament,otherTournament]]);
    await db.query('DELETE FROM tournament_registrations WHERE tournament_id=ANY($1::uuid[])',[[tournament,otherTournament]]);
    await db.query('DELETE FROM tournament_entries WHERE tournament_id=ANY($1::uuid[])',[[tournament,otherTournament]]);
    await db.query('DELETE FROM tournament_admissions WHERE tournament_id=ANY($1::uuid[])',[[tournament,otherTournament]]);
    await db.query('DELETE FROM tournament_entry_codes WHERE tournament_id=ANY($1::uuid[])',[[tournament,otherTournament]]);
    await db.query('DELETE FROM team_memberships WHERE team_id IN (SELECT id FROM teams WHERE course_id=$1)',[course]);
    await db.query('DELETE FROM teams WHERE course_id=$1',[course]);
    await db.query('DELETE FROM tournaments WHERE id=ANY($1::uuid[])',[[tournament,otherTournament]]);
    await db.query('DELETE FROM courses WHERE id=$1',[course]);
    await db.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[students]);
    await db.close();
  });
  it('refuses LAN self-service and limited sessions', async () => {
    await expect(new TeamService(db).createOwnTeam(tournament,'Denied',actor(0))).rejects.toMatchObject({statusCode:403});
    await expect(teams.createOwnTeam(tournament,'Denied',{...actor(0),scope:'PASSWORD_CHANGE_ONLY'} as Actor)).rejects.toMatchObject({statusCode:403});
  });
  it('keeps recipient invitations private and lets captains reload issued invitations', async () => {
    teamId=(await teams.createOwnTeam(tournament,'Online Alpha',actor(0))).id;
    await teams.createOwnTeam(otherTournament,'Online Beta',actor(0));
    const invitation=await teams.issueInvitation(teamId,actor(1).username,actor(0));
    expect(Date.parse(invitation.expiresAt)-Date.parse(invitation.createdAt)).toBe(48*3600*1000);
    expect(await teams.listInvitations(actor(0))).toEqual([expect.objectContaining({id: invitation.id, recipientUserId: students[1]})]);
    expect(await teams.listInvitations(actor(2))).toEqual([]);
    await expect(teams.respondToInvitation(invitation.id,'ACCEPT',actor(2))).rejects.toMatchObject({statusCode:404});
    await teams.respondToInvitation(invitation.id,'ACCEPT',actor(1));
    await expect(teams.respondToInvitation(invitation.id,'ACCEPT',actor(1))).rejects.toMatchObject({statusCode:409});
  });
  it('serializes final slot acceptance and captain transfer/leave', async () => {
    const team=await teams.createOwnTeam(tournament,'Concurrent',actor(2));
    const invites=await Promise.all([teams.issueInvitation(team.id,actor(15).username,actor(2)),teams.issueInvitation(team.id,actor(16).username,actor(2))]);
    const outcomes=await Promise.allSettled(invites.map((invite,i)=>teams.respondToInvitation(invite.id,'ACCEPT',actor(i===0?15:16))));
    const roster=await teams.getTeam(team.id);
    const successor=roster.members.find(m=>m.userId!==students[2])!;
    await expect(teams.leaveTeam(team.id,actor(2))).rejects.toMatchObject({statusCode:409});
    await teams.transferCaptain(team.id,successor.userId,actor(2));
    await teams.leaveTeam(team.id,actor(2));
  });
  it('freezes every mutation when any historical entry exists', async () => {
    const frozen=await teams.createOwnTeam(tournament,'Historical frozen',actor(5));
    await db.query("INSERT INTO tournament_entries(tournament_id,team_id,status) VALUES($1,$2,'ELIGIBLE')",[tournament,frozen.id]);
    await expect(teams.removeMember(frozen.id,students[12],actor(5))).rejects.toMatchObject({statusCode:409});
    await expect(teams.transferCaptain(frozen.id,students[12],actor(5))).rejects.toMatchObject({statusCode:409});
    await expect(teams.leaveTeam(frozen.id,actor(5))).rejects.toMatchObject({statusCode:409});
    await expect(teams.issueInvitation(frozen.id,actor(13).username,actor(5))).rejects.toMatchObject({statusCode:409});
  });
  it('rotates one active revision and revokes without leaking hashes', async () => {
    const ctx: CommandContext={actor:{...actor(0),role:'ADMIN'},requestId:randomUUID()};
    const first=await codes.createCode(tournament,{},ctx);
    const listed=await codes.listCodes(tournament,ctx);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain('code_hash');
    const rotated=await codes.rotateCode(tournament,listed[0].id,{},ctx);
    expect(rotated.revision).toBe(2);
    expect(rotated.code).not.toBe(first.code);
    expect(await codes.listCodes(tournament,ctx)).toHaveLength(1);
    await codes.revokeCode(tournament,listed[0].id,ctx);
    expect(await codes.listCodes(tournament,ctx)).toEqual([]);
  });
  it('binds acceptance to unexpired invitations and supports solo close',async()=>{
    const solo=await teams.createOwnTeam(tournament,'Solo close',actor(6));
    const invitation=await teams.issueInvitation(solo.id,actor(7).username,actor(6));
    await teams.respondToInvitation(invitation.id,'DECLINE',actor(7));
    const next=await teams.issueInvitation(solo.id,actor(7).username,actor(6));
    await teams.revokeInvitation(next.id,actor(6));
    await expect(teams.respondToInvitation(next.id,'ACCEPT',actor(7))).rejects.toMatchObject({statusCode:409});
    const expired=await teams.issueInvitation(solo.id,actor(7).username,actor(6));
    await db.query("UPDATE team_invitations SET created_at=clock_timestamp()-interval '49 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1",[expired.id]);
    await expect(teams.respondToInvitation(expired.id,'ACCEPT',actor(7))).rejects.toMatchObject({statusCode:409});
    await teams.closeTeam(solo.id,actor(6));
    expect((await teams.listOwnTeams(actor(6))).some(t=>t.id===solo.id)).toBe(false);
  });
  it('serializes acceptance versus enrollment without changing admitted rosters',async()=>{
    const race=await teams.createOwnTeam(tournament,'Admission race',actor(8));
    const invitation=await teams.issueInvitation(race.id,actor(9).username,actor(8));
    const ctx:CommandContext={actor:{...actor(8),role:'ADMIN'},requestId:randomUUID()};
    const result=await Promise.allSettled([teams.respondToInvitation(invitation.id,'ACCEPT',actor(9)),new TournamentAdmissionService(db).enrollTeam(tournament,race.id,ctx)]);
    expect(result[1].status).toBe('fulfilled');
    const roster=await teams.getTeam(race.id);
    expect(roster.members.length).toBe(result[0].status==='fulfilled'?2:1);
    await expect(teams.transferCaptain(race.id,students[9],actor(8))).rejects.toMatchObject({statusCode:409});
  });
  it('rejects pending users and ONLINE direct membership/enrollment',async()=>{
    await db.query('UPDATE users SET email_verified_at=NULL WHERE id=$1',[students[10]]);
    await expect(teams.createOwnTeam(tournament,'Pending',actor(10))).rejects.toMatchObject({statusCode:403});
    await db.query('UPDATE users SET email_verified_at=now() WHERE id=$1',[students[10]]);
    const ctx:CommandContext={actor:{...actor(0),role:'ADMIN'},requestId:randomUUID()};
    await expect(teams.addMember(teamId,students[10],ctx.actor)).rejects.toMatchObject({statusCode:403});
    await expect(new TournamentAdmissionService(db,undefined,undefined,undefined,'ONLINE').enrollTeam(tournament,teamId,ctx)).rejects.toMatchObject({statusCode:403});
  });
  it('enforces code rotation and queues approval with durable code provenance',async()=>{
    const captain=actor(11), ctx:CommandContext={actor:{...actor(0),role:'ADMIN'},requestId:randomUUID()};
    const team=await teams.createOwnTeam(tournament,'Code admission',captain);
    const first=await codes.createCode(tournament,{},ctx);
    const second=await codes.rotateCode(tournament,first.id,{},ctx);
    await expect(codes.joinWithCode(tournament,{code:first.code,teamId:team.id},{actor:captain})).rejects.toMatchObject({code:'ENTRY_CODE_INVALID'});
    await db.query("UPDATE tournaments SET registration_closes_at=clock_timestamp()-interval '1 second' WHERE id=$1",[tournament]);
    await expect(codes.joinWithCode(tournament,{code:second.code,teamId:team.id},{actor:captain})).rejects.toMatchObject({code:'TOURNAMENT_NOT_OPEN'});
    await db.query('UPDATE tournaments SET registration_closes_at=NULL WHERE id=$1',[tournament]);
    const requested=await codes.joinWithCode(tournament,{code:second.code,teamId:team.id},{actor:captain});
    expect(requested.status).toBe('PENDING');
    expect((await db.query('SELECT id FROM tournament_admissions WHERE tournament_id=$1 AND team_id=$2',[tournament,team.id])).rows).toEqual([]);
    expect((await db.query('SELECT id FROM tournament_entries WHERE tournament_id=$1 AND team_id=$2',[tournament,team.id])).rows).toEqual([]);
    await codes.revokeCode(tournament,second.id,ctx);
    await registrations.review(tournament,requested.id,{decision:'APPROVE',expectedVersion:1},ctx);
    const provenance=await db.query('SELECT entry_code_id,entry_code_revision FROM tournament_admissions WHERE tournament_id=$1 AND team_id=$2',[tournament,team.id]);
    expect(provenance.rows[0]).toEqual({entry_code_id:second.id,entry_code_revision:2});
    await expect(teams.leaveTeam(team.id,captain)).rejects.toMatchObject({statusCode:409});
  });
  it('persists invalid-code throttles independently of failed redemption transactions',async()=>{
    const ctx={actor:actor(12),ip:students[12]};
    for(let attempt=0;attempt<20;attempt++) await expect(codes.joinWithCode(tournament,{code:'WRONG',teamId},ctx)).rejects.toMatchObject({code:'ENTRY_CODE_INVALID'});
    await expect(codes.joinWithCode(tournament,{code:'WRONG',teamId},ctx)).rejects.toMatchObject({statusCode:429});
  });
  it('allows only one active team per student in a tournament before admission',async()=>{
    const existing=await teams.createOwnTeam(tournament,'First registered team',actor(13));
    await expect(teams.createOwnTeam(tournament,'Second registered team',actor(13))).rejects.toMatchObject({statusCode:409});
    const invitedTeam=await teams.createOwnTeam(tournament,'Invitation target',actor(14));
    const invitation=await teams.issueInvitation(invitedTeam.id,actor(13).username,actor(14));
    await expect(teams.respondToInvitation(invitation.id,'ACCEPT',actor(13))).rejects.toMatchObject({statusCode:409});
    expect((await teams.getTeam(existing.id)).members.map(member=>member.userId)).toEqual([students[13]]);
  });
});
