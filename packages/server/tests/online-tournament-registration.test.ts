import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor, CommandContext } from '@oantuti/protocol';
import { PostgresDatabase } from '../src/persistence/db.js';
import { IdentityService } from '../src/identity/service.js';
import { hashToken } from '../src/identity/crypto.js';
import { TeamService } from '../src/teams/service.js';
import { TournamentRegistrationService } from '../src/tournaments/registration-service.js';
import { TournamentEntryCodeService } from '../src/tournaments/entry-code-service.js';
import { TournamentAdmissionService } from '../src/tournaments/admission-service.js';
import { TournamentLifecycleService } from '../src/tournaments/lifecycle-service.js';
import { registerRegistrationRoutes } from '../src/tournaments/routes.js';
import { SubmissionService } from '../src/submissions/service.js';
import { ArtifactStore } from '../src/submissions/artifact-store.js';
import { JobBroker } from '../src/jobs/broker.js';
import { BackupFence } from '../src/operations/backup-fence.js';
import { createZip } from './helpers/zip.js';

describe('ONLINE durable tournament registration (PostgreSQL)', () => {
  const db = new PostgresDatabase();
  const teams = new TeamService(db, 'ONLINE');
  const registrations = new TournamentRegistrationService(db, 'ONLINE');
  const codes = new TournamentEntryCodeService(db, 'ONLINE', registrations);
  const courseId = randomUUID();
  const users = Array.from({ length: 24 }, () => randomUUID());
  const tournaments: string[] = [];
  const actor = (index: number): Actor => ({ userId: users[index], username: `reg_${users[index]}`, role: index === 0 ? 'ADMIN' : 'STUDENT', scope: 'FULL', teamIds: [] });
  const ctx = (index: number): CommandContext => ({ actor: actor(index), requestId: randomUUID() });
  const cookies = new Map<number, string>();
  let app: FastifyInstance;
  let storageRoot: string;
  let intake: SubmissionService;
  let nextUser = 1;

  async function cup(maxTeams = 4) {
    const id = randomUUID();
    tournaments.push(id);
    await db.query("INSERT INTO tournaments(id,course_id,name,format,state,max_teams,min_team_size,max_team_size) VALUES($1,$2,'Registration cup','ROUND_ROBIN','REGISTRATION_OPEN',$3,1,3)", [id, courseId, maxTeams]);
    return id;
  }
  async function captain(tournamentId: string) {
    const index = nextUser++;
    const team = await teams.createOwnTeam(tournamentId, `Team ${index}`, actor(index));
    return { index, teamId: team.id, context: ctx(index) };
  }
  const upload = { language: 'PYTHON' as const, entrypoint: 'main.py', zipBuffer: createZip({ 'main.py': '# registration intake fixture\n' }) };

  beforeAll(async () => {
    await db.query("INSERT INTO courses(id,code,name) VALUES($1,$2,'Registration tests')", [courseId, `REG_${courseId}`]);
    for (let index = 0; index < users.length; index++) {
      const id = users[index];
      await db.query("INSERT INTO users(id,username,display_name,password_hash,role,activation_method,email,email_verified_at) VALUES($1,$2,'Private student','hash',$3,'SELF_REGISTER',$4,clock_timestamp())", [id, actor(index).username, actor(index).role, `${id}@example.test`]);
      const token = randomBytes(32).toString('hex');
      await db.query("INSERT INTO sessions(user_id,token_hash,scope,expires_at) VALUES($1,$2,'FULL',clock_timestamp()+interval '1 hour')", [id, hashToken(token)]);
      cookies.set(index, `oantuti_session=${token}`);
    }
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'oantuti-registrations-'));
    intake = new SubmissionService(db, new ArtifactStore(db, storageRoot), new JobBroker(db), undefined, 'ONLINE');
    app = Fastify();
    registerRegistrationRoutes(app, registrations, new IdentityService(db, 'ONLINE'));
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db.query('DELETE FROM jobs WHERE target_id IN (SELECT id FROM submissions WHERE tournament_id=ANY($1::uuid[]) UNION ALL SELECT id FROM test_snapshots WHERE tournament_id=ANY($1::uuid[]))', [tournaments]);
    await db.query('UPDATE tournament_entries SET frozen_submission_id=NULL WHERE tournament_id=ANY($1::uuid[])', [tournaments]);
    await db.query('DELETE FROM test_snapshots WHERE tournament_id=ANY($1::uuid[])', [tournaments]);
    await db.query('DELETE FROM submissions WHERE tournament_id=ANY($1::uuid[])', [tournaments]);
    await db.query('DELETE FROM tournament_registrations WHERE tournament_id=ANY($1::uuid[])', [tournaments]);
    await db.query('DELETE FROM tournament_entries WHERE tournament_id=ANY($1::uuid[])', [tournaments]);
    await db.query('DELETE FROM tournament_admissions WHERE tournament_id=ANY($1::uuid[])', [tournaments]);
    await db.query('DELETE FROM tournament_entry_codes WHERE tournament_id=ANY($1::uuid[])', [tournaments]);
    await db.query('DELETE FROM team_invitations WHERE tournament_id=ANY($1::uuid[])', [tournaments]);
    await db.query('DELETE FROM test_create_attempts WHERE tournament_id=ANY($1::uuid[])', [tournaments]);
    await db.query('DELETE FROM team_memberships WHERE team_id IN (SELECT id FROM teams WHERE course_id=$1)', [courseId]);
    await db.query('DELETE FROM teams WHERE course_id=$1', [courseId]);
    await db.query('DELETE FROM outbox_events WHERE payload->>\'tournamentId\'=ANY($1::text[])', [tournaments]);
    await db.query('DELETE FROM tournaments WHERE id=ANY($1::uuid[])', [tournaments]);
    await db.query('DELETE FROM courses WHERE id=$1', [courseId]);
    await db.query('DELETE FROM audit_events WHERE actor_user_id=ANY($1::uuid[])', [users]);
    await db.query('DELETE FROM entry_code_attempts WHERE key_hash=ANY($1::text[])', [users.map(id => hashToken('entry-code:actor:' + id)).concat(hashToken('entry-code:ip:unknown'))]);
    await db.query('DELETE FROM sessions WHERE user_id=ANY($1::uuid[])', [users]);
    await db.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
    await db.query('DELETE FROM submission_sources WHERE storage_path LIKE $1', [storageRoot + '/%']);
    await rm(storageRoot, { recursive: true, force: true });
    await db.close();
  });

  it('creates one durable pending request, freezes its roster, and grants no intake access', async () => {
    const tournamentId = await cup();
    const owner = await captain(tournamentId);
    const pending = await registrations.request(tournamentId, { teamId: owner.teamId }, owner.context);
    expect(pending).toMatchObject({ tournamentId, teamId: owner.teamId, status: 'PENDING', version: 1, reason: null, reviewedAt: null, canCancel: true });
    expect(pending.members).toEqual([{ userId: users[owner.index], username: actor(owner.index).username, displayName: 'Private student', role: 'CAPTAIN' }]);
    expect((await db.query('SELECT id FROM tournament_admissions WHERE tournament_id=$1', [tournamentId])).rows).toEqual([]);
    expect((await db.query('SELECT id FROM tournament_entries WHERE tournament_id=$1', [tournamentId])).rows).toEqual([]);
    await expect(registrations.request(tournamentId, { teamId: owner.teamId }, owner.context)).rejects.toMatchObject({ statusCode: 409, code: 'ALREADY_REGISTERED' });
    await expect(teams.issueInvitation(owner.teamId, actor(23).username, actor(owner.index))).rejects.toMatchObject({ statusCode: 409 });
    await expect(teams.closeTeam(owner.teamId, actor(owner.index))).rejects.toMatchObject({ statusCode: 409 });
    const member = { ...actor(owner.index), teamIds: [owner.teamId] };
    await expect(intake.submit(tournamentId, owner.teamId, upload, member)).rejects.toMatchObject({ statusCode: 403, code: 'TEAM_NOT_APPROVED' });
    await expect(intake.createPrivateTest(tournamentId, owner.teamId, upload, member)).rejects.toMatchObject({ statusCode: 403, code: 'TEAM_NOT_APPROVED' });
    await expect(intake.recordTestCreateAttempt(tournamentId, owner.teamId, member)).rejects.toMatchObject({ statusCode: 403, code: 'TEAM_NOT_APPROVED' });
    expect((await teams.getTeam(owner.teamId)).rosterLocked).toBe(true);
    const loaded = await new TournamentRegistrationService(db, 'ONLINE').list(tournamentId, owner.context);
    expect(loaded).toEqual([pending]);
  });

  it('keeps reasons and rosters private to the team and administrators over HTTP', async () => {
    const tournamentId = await cup();
    const owner = await captain(tournamentId);
    const invitation = await teams.issueInvitation(owner.teamId, actor(23).username, actor(owner.index));
    await teams.respondToInvitation(invitation.id, 'ACCEPT', actor(23));
    const requested = await app.inject({ method: 'POST', url: `/api/v2/tournaments/${tournamentId}/registrations`, headers: { cookie: cookies.get(owner.index)! }, payload: { teamId: owner.teamId } });
    expect(requested.statusCode).toBe(201);
    const pending = requested.json();
    const rejected = await app.inject({ method: 'POST', url: `/api/v2/organizer/tournaments/${tournamentId}/registrations/${pending.id}/review`, headers: { cookie: cookies.get(0)! }, payload: { decision: 'REJECT', reason: 'Private organizer feedback', expectedVersion: 1 } });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({ status: 'REJECTED', version: 2, reason: 'Private organizer feedback' });
    const list = (index?: number) => app.inject({ method: 'GET', url: `/api/v2/tournaments/${tournamentId}/registrations`, headers: index === undefined ? {} : { cookie: cookies.get(index)! } });
    expect((await list()).statusCode).toBe(401);
    expect((await list(22)).json()).toEqual({ registrations: [] });
    expect((await list(23)).json().registrations).toEqual([expect.objectContaining({ id: pending.id, reason: 'Private organizer feedback', canCancel: false })]);
    expect((await list(0)).json().registrations).toHaveLength(1);
    const memberCancel = await app.inject({ method: 'POST', url: `/api/v2/tournaments/${tournamentId}/registrations/${pending.id}/cancel`, headers: { cookie: cookies.get(23)! }, payload: { expectedVersion: 2 } });
    expect(memberCancel.statusCode).toBe(403);
    expect(memberCancel.json()).toMatchObject({ code: 'TEAM_CAPTAIN_REQUIRED', message: expect.any(String) });
    expect((await db.query("SELECT id FROM outbox_events WHERE payload->>'reason'='Private organizer feedback'")).rows).toEqual([]);
  });

  it('requires the verified FULL ONLINE captain and an active matching team/window', async () => {
    const tournamentId = await cup();
    const owner = await captain(tournamentId);
    await expect(new TournamentRegistrationService(db).request(tournamentId, { teamId: owner.teamId }, owner.context)).rejects.toMatchObject({ statusCode: 403 });
    await expect(registrations.request(tournamentId, { teamId: owner.teamId }, ctx(0))).rejects.toMatchObject({ statusCode: 403 });
    await expect(registrations.request(tournamentId, { teamId: owner.teamId }, { actor: { ...actor(owner.index), scope: 'PASSWORD_CHANGE_ONLY' } })).rejects.toMatchObject({ statusCode: 403 });
    await expect(registrations.request(tournamentId, { teamId: owner.teamId }, ctx(22))).rejects.toMatchObject({ statusCode: 403, code: 'TEAM_CAPTAIN_REQUIRED' });
    await db.query('UPDATE users SET email_verified_at=NULL WHERE id=$1', [users[owner.index]]);
    await expect(registrations.request(tournamentId, { teamId: owner.teamId }, owner.context)).rejects.toMatchObject({ statusCode: 403, code: 'EMAIL_NOT_VERIFIED' });
    await db.query('UPDATE users SET email_verified_at=clock_timestamp() WHERE id=$1', [users[owner.index]]);
    const other = await cup();
    await expect(registrations.request(other, { teamId: owner.teamId }, owner.context)).rejects.toMatchObject({ statusCode: 409, code: 'TEAM_POLICY_MISMATCH' });
    await db.query("UPDATE tournaments SET registration_opens_at=clock_timestamp()+interval '1 hour' WHERE id=$1", [tournamentId]);
    await expect(registrations.request(tournamentId, { teamId: owner.teamId }, owner.context)).rejects.toMatchObject({ code: 'REGISTRATION_WINDOW_CLOSED' });
    await db.query("UPDATE tournaments SET registration_opens_at=NULL,registration_closes_at=clock_timestamp()-interval '1 second' WHERE id=$1", [tournamentId]);
    await expect(registrations.request(tournamentId, { teamId: owner.teamId }, owner.context)).rejects.toMatchObject({ code: 'REGISTRATION_WINDOW_CLOSED' });
    await db.query('UPDATE tournaments SET registration_closes_at=NULL WHERE id=$1', [tournamentId]);
    await teams.closeTeam(owner.teamId, actor(owner.index));
    await expect(registrations.request(tournamentId, { teamId: owner.teamId }, owner.context)).rejects.toMatchObject({ code: 'TEAM_CLOSED' });
    await expect(new TournamentAdmissionService(db, undefined, undefined, undefined, 'ONLINE').enrollTeam(tournamentId, owner.teamId, ctx(0))).rejects.toMatchObject({ statusCode: 403 });
  });

  it('validates decisions/reasons, rejects stale decisions and permits rejected re-requests', async () => {
    const tournamentId = await cup();
    const owner = await captain(tournamentId);
    const pending = await registrations.request(tournamentId, { teamId: owner.teamId }, owner.context);
    for (const reason of ['', '   ', 'x'.repeat(501)]) {
      await expect(registrations.review(tournamentId, pending.id, { decision: 'REJECT', reason, expectedVersion: 1 }, ctx(0))).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_REASON' });
    }
    await expect(registrations.review(tournamentId, pending.id, { decision: 'APPROVE', expectedVersion: 1 }, owner.context)).rejects.toMatchObject({ statusCode: 403 });
    await expect(registrations.review(tournamentId, pending.id, { decision: 'APPROVE', expectedVersion: 0 }, ctx(0))).rejects.toMatchObject({ statusCode: 400 });
    const rejected = await registrations.review(tournamentId, pending.id, { decision: 'REJECT', reason: ' Please revise roster ', expectedVersion: 1 }, ctx(0));
    expect(rejected).toMatchObject({ status: 'REJECTED', reason: 'Please revise roster', version: 2 });
    await expect(registrations.review(tournamentId, pending.id, { decision: 'APPROVE', expectedVersion: 1 }, ctx(0))).rejects.toMatchObject({ code: 'STALE_VERSION' });
    await teams.issueInvitation(owner.teamId, actor(22).username, actor(owner.index));
    const again = await registrations.request(tournamentId, { teamId: owner.teamId }, owner.context);
    expect(again).toMatchObject({ id: pending.id, status: 'PENDING', version: 3, reason: null, reviewedAt: null });
    const approved = await registrations.review(tournamentId, pending.id, { decision: 'APPROVE', expectedVersion: 3 }, ctx(0));
    expect(approved).toMatchObject({ status: 'APPROVED', version: 4, reason: null });
    expect((await db.query('SELECT admission_type FROM tournament_admissions WHERE tournament_id=$1 AND team_id=$2', [tournamentId, owner.teamId])).rows).toEqual([{ admission_type: 'REGISTRATION_APPROVAL' }]);
    expect((await db.query('SELECT status FROM tournament_entries WHERE tournament_id=$1 AND team_id=$2', [tournamentId, owner.teamId])).rows).toEqual([{ status: 'ELIGIBLE' }]);
    await expect(teams.leaveTeam(owner.teamId, actor(owner.index))).rejects.toMatchObject({ statusCode: 409 });
  });

  it('serializes review against captain cancellation and preserves admission/source history on reapproval', async () => {
    const tournamentId = await cup();
    const owner = await captain(tournamentId);
    const pending = await registrations.request(tournamentId, { teamId: owner.teamId }, owner.context);
    const outcomes = await Promise.allSettled([
      registrations.review(tournamentId, pending.id, { decision: 'APPROVE', expectedVersion: 1 }, ctx(0)),
      registrations.cancel(tournamentId, pending.id, { expectedVersion: 1 }, owner.context),
    ]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(result => result.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ code: 'STALE_VERSION' }) })]);
    let current = (await registrations.list(tournamentId, owner.context))[0];
    if (current.status === 'CANCELLED') {
      current = await registrations.request(tournamentId, { teamId: owner.teamId }, owner.context);
      current = await registrations.review(tournamentId, current.id, { decision: 'APPROVE', expectedVersion: current.version }, ctx(0));
    }
    const member = { ...actor(owner.index), teamIds: [owner.teamId] };
    const receipt = await intake.submit(tournamentId, owner.teamId, upload, member);
    const before = (await db.query('SELECT id,created_at FROM tournament_admissions WHERE tournament_id=$1 AND team_id=$2', [tournamentId, owner.teamId])).rows[0];
    const entry = (await db.query('SELECT id FROM tournament_entries WHERE tournament_id=$1 AND team_id=$2', [tournamentId, owner.teamId])).rows[0];
    const cancelled = await registrations.cancel(tournamentId, current.id, { expectedVersion: current.version }, owner.context);
    expect(cancelled).toMatchObject({ status: 'CANCELLED', canCancel: false });
    expect((await db.query('SELECT status,global_rating_exclusion FROM tournament_entries WHERE id=$1', [entry.id])).rows[0]).toEqual({ status: 'EXCLUDED', global_rating_exclusion: 'PRESTART_EXCLUDED' });
    await expect(intake.submit(tournamentId, owner.teamId, upload, member)).rejects.toMatchObject({ code: 'TEAM_NOT_APPROVED' });
    await expect(intake.createPrivateTest(tournamentId, owner.teamId, upload, member)).rejects.toMatchObject({ code: 'TEAM_NOT_APPROVED' });
    expect((await db.query('SELECT id FROM submissions WHERE id=$1', [receipt.data.submissionId])).rows).toHaveLength(1);
    const requested = await registrations.request(tournamentId, { teamId: owner.teamId }, owner.context);
    await registrations.review(tournamentId, requested.id, { decision: 'APPROVE', expectedVersion: requested.version }, ctx(0));
    expect((await db.query('SELECT id,created_at FROM tournament_admissions WHERE tournament_id=$1 AND team_id=$2', [tournamentId, owner.teamId])).rows[0]).toEqual(before);
    expect((await db.query('SELECT id,status,global_rating_exclusion FROM tournament_entries WHERE tournament_id=$1 AND team_id=$2', [tournamentId, owner.teamId])).rows[0]).toEqual({ id: entry.id, status: 'ELIGIBLE', global_rating_exclusion: null });
    await intake.createPrivateTest(tournamentId, owner.teamId, upload, member);
  });

  it('serializes the final approval slot, frees cancelled slots, and never reactivates administrator exclusions', async () => {
    const tournamentId = await cup(1);
    const a = await captain(tournamentId), b = await captain(tournamentId);
    const requests = await Promise.all([registrations.request(tournamentId, { teamId: a.teamId }, a.context), registrations.request(tournamentId, { teamId: b.teamId }, b.context)]);
    const outcomes = await Promise.allSettled(requests.map(request => registrations.review(tournamentId, request.id, { decision: 'APPROVE', expectedVersion: 1 }, ctx(0))));
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(result => result.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ code: 'CAPACITY_EXCEEDED' }) })]);
    const winnerIndex = outcomes[0].status === 'fulfilled' ? 0 : 1;
    const owners = [a, b];
    const winner = owners[winnerIndex], loser = owners[1 - winnerIndex];
    const current = (await registrations.list(tournamentId, winner.context))[0];
    await registrations.cancel(tournamentId, current.id, { expectedVersion: current.version }, winner.context);
    const waiting = (await registrations.list(tournamentId, loser.context))[0];
    await registrations.review(tournamentId, waiting.id, { decision: 'APPROVE', expectedVersion: waiting.version }, ctx(0));
    await new TournamentAdmissionService(db).withdrawTeam(tournamentId, loser.teamId, 'Organizer excluded', ctx(0));
    const excluded = (await registrations.list(tournamentId, loser.context))[0];
    expect(excluded).toMatchObject({ status: 'CANCELLED', version: 3, canCancel: false });
    await expect(registrations.cancel(tournamentId, waiting.id, { expectedVersion: 2 }, loser.context)).rejects.toMatchObject({ code: 'STALE_VERSION' });
    await expect(registrations.cancel(tournamentId, waiting.id, { expectedVersion: 3 }, loser.context)).rejects.toMatchObject({ code: 'REGISTRATION_NOT_CANCELLABLE' });
    await expect(registrations.request(tournamentId, { teamId: loser.teamId }, loser.context)).rejects.toMatchObject({ code: 'ENTRY_NOT_REAPPLICABLE' });
    expect((await db.query("SELECT id FROM tournament_entries WHERE tournament_id=$1 AND status='ELIGIBLE'", [tournamentId])).rows).toEqual([]);
  });

  it('blocks locking unresolved requests, accepts admin review after close, and never revives cancelled entries at lock', async () => {
    const tournamentId = await cup();
    const owner = await captain(tournamentId);
    const pending = await registrations.request(tournamentId, { teamId: owner.teamId }, owner.context);
    await new TournamentAdmissionService(db).closeRegistration(tournamentId, ctx(0));
    await expect(new TournamentLifecycleService(db).lock(tournamentId, ctx(0))).rejects.toMatchObject({ statusCode: 409, code: 'REGISTRATIONS_PENDING' });
    await expect(registrations.cancel(tournamentId, pending.id, { expectedVersion: 1 }, owner.context)).rejects.toMatchObject({ code: 'REGISTRATION_WINDOW_CLOSED' });
    const approved = await registrations.review(tournamentId, pending.id, { decision: 'APPROVE', expectedVersion: 1 }, ctx(0));
    expect(approved.status).toBe('APPROVED');
    await new TournamentLifecycleService(db).lock(tournamentId, ctx(0));
    await expect(registrations.review(tournamentId, pending.id, { decision: 'REJECT', reason: 'Late', expectedVersion: 2 }, ctx(0))).rejects.toMatchObject({ code: 'TOURNAMENT_LOCKED' });
    const cancelledCup = await cup();
    const cancelledOwner = await captain(cancelledCup);
    let request = await registrations.request(cancelledCup, { teamId: cancelledOwner.teamId }, cancelledOwner.context);
    request = await registrations.review(cancelledCup, request.id, { decision: 'APPROVE', expectedVersion: 1 }, ctx(0));
    const member = { ...actor(cancelledOwner.index), teamIds: [cancelledOwner.teamId] };
    const receipt = await intake.submit(cancelledCup, cancelledOwner.teamId, upload, member);
    await db.query("UPDATE submissions SET status='READY' WHERE id=$1", [receipt.data.submissionId]);
    await registrations.cancel(cancelledCup, request.id, { expectedVersion: 2 }, cancelledOwner.context);
    await new TournamentLifecycleService(db).lock(cancelledCup, ctx(0));
    expect((await db.query('SELECT status,frozen_submission_id FROM tournament_entries WHERE tournament_id=$1', [cancelledCup])).rows).toEqual([{ status: 'EXCLUDED', frozen_submission_id: null }]);
  });

  it('queues code redemptions with provenance and consumes no extra uses on duplicate requests', async () => {
    const tournamentId = await cup(1);
    const owner = await captain(tournamentId);
    const code = await codes.createCode(tournamentId, { maxUses: 2 }, ctx(0));
    const joined = await codes.joinWithCode(tournamentId, { teamId: owner.teamId, code: code.code }, owner.context);
    expect(joined).toMatchObject({ status: 'PENDING', version: 1, members: expect.any(Array) });
    expect((await db.query('SELECT id FROM tournament_entries WHERE tournament_id=$1', [tournamentId])).rows).toEqual([]);
    expect((await db.query('SELECT id FROM tournament_admissions WHERE tournament_id=$1', [tournamentId])).rows).toEqual([]);
    await expect(codes.joinWithCode(tournamentId, { teamId: owner.teamId, code: code.code }, owner.context)).rejects.toMatchObject({ code: 'ALREADY_REGISTERED' });
    expect((await codes.listCodes(tournamentId, ctx(0)))[0].uses).toBe(1);
    await codes.revokeCode(tournamentId, code.id, ctx(0));
    await registrations.review(tournamentId, joined.id, { decision: 'APPROVE', expectedVersion: 1 }, ctx(0));
    expect((await db.query('SELECT admission_type,entry_code_id,entry_code_revision FROM tournament_admissions WHERE tournament_id=$1', [tournamentId])).rows).toEqual([{ admission_type: 'REGISTRATION_APPROVAL', entry_code_id: code.id, entry_code_revision: 1 }]);
  });

  it('rejects malformed and missing targets with structured errors rather than database exceptions', async () => {
    const tournamentId = await cup();
    const headers = { cookie: cookies.get(1)! };
    for (const [method, url, payload] of [
      ['GET', '/api/v2/tournaments/not-a-uuid/registrations', undefined],
      ['POST', `/api/v2/tournaments/${tournamentId}/registrations`, { teamId: 'bad' }],
      ['POST', `/api/v2/tournaments/${tournamentId}/registrations/bad/cancel`, { expectedVersion: 1 }],
      ['POST', `/api/v2/tournaments/${tournamentId}/registrations/${randomUUID()}/cancel`, { expectedVersion: 0 }],
    ] as const) {
      const response = await app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: expect.any(String), message: expect.any(String) });
    }
    const missing = await app.inject({ method: 'GET', url: `/api/v2/tournaments/${randomUUID()}/registrations`, headers });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('TOURNAMENT_NOT_FOUND');
    const lanApp = Fastify();
    registerRegistrationRoutes(lanApp, new TournamentRegistrationService(db), new IdentityService(db));
    const disabled = await lanApp.inject({ method: 'GET', url: `/api/v2/tournaments/${tournamentId}/registrations`, headers });
    expect([disabled.statusCode, disabled.json().code]).toEqual([404, 'PROFILE_DISABLED']);
    await lanApp.close();
  });

  it('uses the protected-write backup fence for pending requests as well as approval', async () => {
    const tournamentId = await cup();
    const owner = await captain(tournamentId);
    const fenced = new TournamentRegistrationService(db, 'ONLINE', new BackupFence(db, { enforcement: 'enforce', maxLagMinutes: Number.MIN_VALUE }));
    await expect(fenced.request(tournamentId, { teamId: owner.teamId }, owner.context)).rejects.toMatchObject({ statusCode: 409 });
    expect(await registrations.list(tournamentId, owner.context)).toEqual([]);
    const pending = await registrations.request(tournamentId, { teamId: owner.teamId }, owner.context);
    await expect(fenced.review(tournamentId, pending.id, { decision: 'APPROVE', expectedVersion: 1 }, ctx(0))).rejects.toMatchObject({ statusCode: 409 });
    expect((await registrations.list(tournamentId, owner.context))[0]).toMatchObject({ status: 'PENDING', version: 1 });
  });
});
