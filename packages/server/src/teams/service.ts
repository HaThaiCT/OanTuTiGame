import type { PoolClient } from 'pg';
import type { Database } from '../persistence/db.js';
import type { Actor, Instant, Role, UUID } from '@oantuti/protocol';
import type { TeamDto, TeamInvitationDto, TournamentSubstrateDto } from '@oantuti/protocol';
import { hasActiveTournamentTeam, lockRosterAdmission, rosterIsLocked } from './roster-policy.js';

export class TeamError extends Error {
  constructor(readonly statusCode: number, message: string, readonly code = 'TEAM_OPERATION_FAILED') {
    super(message);
    this.name = 'TeamError';
  }
}

interface CourseRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly created_at: Date;
}

interface TeamRow {
  readonly id: string;
  readonly course_id: string;
  readonly name: string;
  readonly captain_user_id: string;
  readonly created_at: Date;
}

interface TournamentRow {
  readonly id: string;
  readonly course_id: string;
  readonly name: string;
  readonly format: 'SINGLE_ELIMINATION' | 'SWISS_PLAYOFF' | 'ROUND_ROBIN' | 'ELO_ARENA';
  readonly state: 'DRAFT' | 'PUBLISHED' | 'REGISTRATION_OPEN' | 'VALIDATING_SUBMISSIONS' | 'LOCKED' | 'READY_TO_START' | 'RUNNING' | 'PAUSED' | 'PROVISIONAL' | 'FINALIZED' | 'ARCHIVED' | 'CANCELLED';
  readonly version: number;
  readonly rules_revision: string;
  readonly max_teams: number;
  readonly min_team_size: number;
  readonly is_rated: boolean;
  readonly max_team_size: number;
  readonly registration_opens_at: Date | null;
  readonly registration_closes_at: Date | null;
  readonly created_at: Date;
}


export class TeamService {
  constructor(private readonly db: Database, private readonly profile: 'LAN_OFFLINE' | 'ONLINE' = 'LAN_OFFLINE') {}

  private async requireStudent(actor: Actor, client?: PoolClient): Promise<void> {
    if(this.profile !== 'ONLINE' || actor.role !== 'STUDENT' || actor.scope !== 'FULL') throw new TeamError(403,'ONLINE verified FULL student required');
    const q=client ? client.query.bind(client) : this.db.query.bind(this.db);
    const user=await q('SELECT 1 FROM users WHERE id=$1 AND role=\'STUDENT\' AND email IS NOT NULL AND email_verified_at IS NOT NULL',[actor.userId]);
    if(!user.rows.length) throw new TeamError(403,'Verified email required');
  }

  private async mutableTeam(client: PoolClient, teamId: string, actor: Actor, captain: boolean | 'INVITEE'=true): Promise<TeamDto> {
    await this.requireStudent(actor,client);
    const policy=await client.query<{tournament_id:string|null}>('SELECT tournament_id FROM teams WHERE id=$1',[teamId]);
    if(!policy.rows[0]?.tournament_id) throw new TeamError(404,'Online team not found');
    await client.query('SELECT id FROM tournaments WHERE id=$1 FOR UPDATE',[policy.rows[0].tournament_id]);
    await client.query('SELECT id FROM teams WHERE id=$1 FOR UPDATE',[teamId]);
    await client.query('SELECT id FROM users WHERE id IN (SELECT user_id FROM team_memberships WHERE team_id=$1) OR id=$2 ORDER BY id FOR UPDATE',[teamId,actor.userId]);
    const team=await this.getTeam(teamId,client);
    if(team.closedAt || await rosterIsLocked(client,teamId)) throw new TeamError(409,'ROSTER_LOCKED: enrollment permanently freezes the roster');
    if(captain===true && team.captainUserId!==actor.userId) throw new TeamError(403,'Captain required');
    if(captain===false && !team.members.some(m=>m.userId===actor.userId)) throw new TeamError(403,'Membership required');
    return team;
  }

  private async auditTeam(client: PoolClient, actor: Actor, action: string, teamId: string): Promise<void> {
    await client.query("INSERT INTO audit_events(actor_user_id,action,resource_type,resource_id,details) VALUES($1,$2,'team',$3,'{}')",[actor.userId,action,teamId]);
  }

  async createOwnTeam(tournamentId: string, name: string, actor: Actor): Promise<TeamDto> {
    await this.requireStudent(actor);
    if(typeof name!=='string' || name.trim().length<2 || name.trim().length>50) throw new TeamError(400,'Invalid team name');
    return this.db.withTransaction(async client=>{
      await lockRosterAdmission(client);
      const policy=await client.query<{course_id:string;open:boolean}>(`SELECT course_id,state='REGISTRATION_OPEN' AND (registration_opens_at IS NULL OR registration_opens_at<=clock_timestamp()) AND (registration_closes_at IS NULL OR registration_closes_at>clock_timestamp()) AS open FROM tournaments WHERE id=$1 FOR UPDATE`,[tournamentId]);
      if(!policy.rows[0]?.open) throw new TeamError(409,'Registration is not open');
      if(await hasActiveTournamentTeam(client,tournamentId,actor.userId)) throw new TeamError(409,'This student already has a team in the selected tournament.','TEAM_MEMBERSHIP_CONFLICT');
      const duplicate=await client.query('SELECT 1 FROM teams WHERE course_id=$1 AND name=$2',[policy.rows[0].course_id,name.trim()]);
      if(duplicate.rows.length) throw new TeamError(409,'Team name already exists');
      const inserted=await client.query<{id:string}>(`INSERT INTO teams(course_id,name,captain_user_id,tournament_id) VALUES($1,$2,$3,$4) RETURNING id`,[policy.rows[0].course_id,name.trim(),actor.userId,tournamentId]);
      const id=inserted.rows[0].id;
      await client.query("INSERT INTO team_memberships(team_id,user_id,role) VALUES($1,$2,'CAPTAIN')",[id,actor.userId]);
      await this.auditTeam(client,actor,'TEAM_CREATED',id);
      return this.getTeam(id,client);
    });
  }

  async listOwnTeams(actor: Actor): Promise<TeamDto[]> {
    await this.requireStudent(actor);
    const rows=await this.db.query<{id:string}>('SELECT team.id FROM teams team JOIN team_memberships m ON m.team_id=team.id WHERE m.user_id=$1 AND team.closed_at IS NULL ORDER BY team.created_at',[actor.userId]);
    return Promise.all(rows.rows.map(row=>this.getTeam(row.id)));
  }

  private async invitation(client: PoolClient, id: string): Promise<TeamInvitationDto> {
    const result=await client.query<{id:string;team_id:string;team_name:string;tournament_id:string;recipient_user_id:string;status:TeamInvitationDto['status'];expires_at:Date;created_at:Date}>(`SELECT i.*,t.name AS team_name FROM team_invitations i JOIN teams t ON t.id=i.team_id WHERE i.id=$1`,[id]);
    const row=result.rows[0];
    if(!row) throw new TeamError(404,'Invitation not found');
    return {id:row.id,teamId:row.team_id,teamName:row.team_name,tournamentId:row.tournament_id,recipientUserId:row.recipient_user_id,status:row.status,expiresAt:row.expires_at.toISOString(),createdAt:row.created_at.toISOString()};
  }

  async issueInvitation(teamId: string, username: string, actor: Actor): Promise<TeamInvitationDto> {
    return this.db.withTransaction(async client=>{
      await lockRosterAdmission(client);
      if(typeof username!=='string' || !username.trim()) throw new TeamError(400,'Username required');
      const team=await this.mutableTeam(client,teamId,actor);
      const recipient=await client.query<{id:string}>('SELECT id FROM users WHERE username=$1 AND role=\'STUDENT\' AND email_verified_at IS NOT NULL',[username]);
      const id=recipient.rows[0]?.id;
      if(!id) throw new TeamError(404,'Recipient not found');
      if(team.members.some(m=>m.userId===id)) throw new TeamError(409,'Already a member');
      await client.query("UPDATE team_invitations SET status='REVOKED',responded_at=clock_timestamp() WHERE team_id=$1 AND recipient_user_id=$2 AND status='PENDING' AND expires_at<=clock_timestamp()",[teamId,id]);
      const duplicate=await client.query("SELECT 1 FROM team_invitations WHERE team_id=$1 AND recipient_user_id=$2 AND status='PENDING'",[teamId,id]);
      if(duplicate.rows.length) throw new TeamError(409,'Invitation already pending');
      const inserted=await client.query<{id:string}>(`WITH instant AS (SELECT clock_timestamp() AS at) INSERT INTO team_invitations(team_id,tournament_id,recipient_user_id,invited_by_user_id,created_at,expires_at) SELECT $1,$2,$3,$4,at,at+interval '48 hours' FROM instant RETURNING id`,[teamId,team.tournamentId,id,actor.userId]);
      await this.auditTeam(client,actor,'TEAM_INVITATION_CREATED',teamId);
      return this.invitation(client,inserted.rows[0].id);
    });
  }

  async listInvitations(actor: Actor): Promise<TeamInvitationDto[]> {
    await this.requireStudent(actor);
    return this.db.withTransaction(async client=>{
      const rows=await client.query<{id:string}>("SELECT i.id FROM team_invitations i JOIN teams t ON t.id=i.team_id WHERE (i.recipient_user_id=$1 OR t.captain_user_id=$1) AND i.status='PENDING' AND i.expires_at>clock_timestamp() ORDER BY i.created_at DESC",[actor.userId]);
      return Promise.all(rows.rows.map(row=>this.invitation(client,row.id)));
    });
  }

  async respondToInvitation(id: string, decision: 'ACCEPT'|'DECLINE', actor: Actor): Promise<TeamInvitationDto> {
    await this.requireStudent(actor);
    if(decision!=='ACCEPT' && decision!=='DECLINE') throw new TeamError(400,'Invalid invitation decision');
    return this.db.withTransaction(async client=>{
      await lockRosterAdmission(client);
      const invite=await this.invitation(client,id);
      if(invite.recipientUserId!==actor.userId) throw new TeamError(404,'Invitation not found');
      const valid=await client.query("SELECT 1 FROM team_invitations WHERE id=$1 AND status='PENDING' AND expires_at>clock_timestamp()",[id]);
      if(!valid.rows.length) throw new TeamError(409,'Invitation expired or already used');
      if(decision==='ACCEPT') {
        const teamPolicy=await client.query<{open:boolean;max_team_size:number}>(`SELECT state='REGISTRATION_OPEN' AND (registration_opens_at IS NULL OR registration_opens_at<=clock_timestamp()) AND (registration_closes_at IS NULL OR registration_closes_at>clock_timestamp()) AS open,max_team_size FROM tournaments WHERE id=$1 FOR UPDATE`,[invite.tournamentId]);
        if(!teamPolicy.rows[0]?.open) throw new TeamError(409,'Registration is not open');
        const team=await this.mutableTeam(client,invite.teamId,actor,'INVITEE');
        if(team.members.length>=teamPolicy.rows[0].max_team_size) throw new TeamError(409,'Team is full');
        if(await hasActiveTournamentTeam(client,invite.tournamentId,actor.userId,invite.teamId)) throw new TeamError(409,'This student already has a team in this tournament.','TEAM_MEMBERSHIP_CONFLICT');
        if(team.members.some(m=>m.userId===actor.userId)) throw new TeamError(409,'Already a member');
        await client.query("INSERT INTO team_memberships(team_id,user_id,role) VALUES($1,$2,'MEMBER')",[invite.teamId,actor.userId]);
      }
      await client.query('UPDATE team_invitations SET status=$2,responded_at=clock_timestamp() WHERE id=$1',[id,decision==='ACCEPT'?'ACCEPTED':'DECLINED']);
      await this.auditTeam(client,actor,'TEAM_INVITATION_'+decision,invite.teamId);
      return this.invitation(client,id);
    });
  }

  async revokeInvitation(id: string, actor: Actor): Promise<TeamInvitationDto> {
    return this.db.withTransaction(async client=>{
      await lockRosterAdmission(client);
      const invite=await this.invitation(client,id);
      await this.mutableTeam(client,invite.teamId,actor);
      if(invite.status!=='PENDING') throw new TeamError(409,'Invitation already used');
      await client.query("UPDATE team_invitations SET status='REVOKED',responded_at=clock_timestamp() WHERE id=$1",[id]);
      await this.auditTeam(client,actor,'TEAM_INVITATION_REVOKED',invite.teamId);
      return this.invitation(client,id);
    });
  }

  async removeMember(teamId: string, userId: string, actor: Actor): Promise<TeamDto> {
    return this.db.withTransaction(async client=>{
      await lockRosterAdmission(client);
      const team=await this.mutableTeam(client,teamId,actor);
      if(userId===team.captainUserId) throw new TeamError(409,'Transfer captain before leaving');
      if(!team.members.some(m=>m.userId===userId)) throw new TeamError(404,'Member not found');
      await client.query('DELETE FROM team_memberships WHERE team_id=$1 AND user_id=$2',[teamId,userId]);
      await this.auditTeam(client,actor,'TEAM_MEMBER_REMOVED',teamId);
      return this.getTeam(teamId,client);
    });
  }

  async transferCaptain(teamId: string, userId: string, actor: Actor): Promise<TeamDto> {
    return this.db.withTransaction(async client=>{
      await lockRosterAdmission(client);
      const team=await this.mutableTeam(client,teamId,actor);
      if(userId===team.captainUserId || !team.members.some(m=>m.userId===userId)) throw new TeamError(409,'Select another member');
      await client.query("UPDATE team_memberships SET role=CASE WHEN user_id=$2 THEN 'CAPTAIN' ELSE 'MEMBER' END WHERE team_id=$1",[teamId,userId]);
      await client.query('UPDATE teams SET captain_user_id=$2 WHERE id=$1',[teamId,userId]);
      await this.auditTeam(client,actor,'TEAM_CAPTAIN_TRANSFERRED',teamId);
      return this.getTeam(teamId,client);
    });
  }

  async leaveTeam(teamId: string, actor: Actor): Promise<void> {
    return this.db.withTransaction(async client=>{
      await lockRosterAdmission(client);
      const team=await this.mutableTeam(client,teamId,actor,false);
      if(team.captainUserId===actor.userId) throw new TeamError(409,'Transfer captain or close solo team');
      await client.query('DELETE FROM team_memberships WHERE team_id=$1 AND user_id=$2',[teamId,actor.userId]);
      await this.auditTeam(client,actor,'TEAM_MEMBER_LEFT',teamId);
    });
  }

  async closeTeam(teamId: string, actor: Actor): Promise<void> {
    return this.db.withTransaction(async client=>{
      await lockRosterAdmission(client);
      const team=await this.mutableTeam(client,teamId,actor);
      if(team.members.length!==1) throw new TeamError(409,'Only a solo team may close');
      await client.query('UPDATE teams SET closed_at=clock_timestamp() WHERE id=$1',[teamId]);
      await client.query("UPDATE team_invitations SET status='REVOKED',responded_at=clock_timestamp() WHERE team_id=$1 AND status='PENDING'",[teamId]);
      await this.auditTeam(client,actor,'TEAM_CLOSED',teamId);
    });
  }
  async listTeamsForOrganizer(options: { readonly q: string; readonly limit: number; readonly offset: number }, actor: Actor): Promise<{ teams: readonly { id: string; name: string; courseId: string; courseCode: string }[]; total: number }> {
    if (actor.role !== 'ADMIN' || actor.scope !== 'FULL') throw new TeamError(403, 'Only fully authenticated administrators can search teams');
    const q = typeof options.q === 'string' ? options.q.trim() : '';
    if (q.length > 100 || !Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100 || !Number.isInteger(options.offset) || options.offset < 0 || options.offset > 10000) throw new TeamError(400, 'Invalid team search query');
    const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    const result = await this.db.query<{ id: string; name: string; course_id: string; course_code: string; total: string }>(
      `SELECT t.id,t.name,t.course_id,c.code AS course_code,count(*) OVER()::text AS total FROM teams t JOIN courses c ON c.id=t.course_id
       WHERE t.name ILIKE $1 ESCAPE '\\' OR t.id::text ILIKE $1 ESCAPE '\\' ORDER BY t.name,t.id LIMIT $2 OFFSET $3`, [pattern, options.limit, options.offset]);
    return { teams: result.rows.map((row) => ({ id: row.id, name: row.name, courseId: row.course_id, courseCode: row.course_code })), total: Number(result.rows[0]?.total ?? 0) };
  }

  async createCourse(code: string, name: string, actor: Actor): Promise<CourseRow> {
    if (actor.role !== 'ADMIN') {
      throw new TeamError(403, 'Only ADMIN can create courses');
    }
    const cleanCode = code.trim().toUpperCase();
    const cleanName = name.trim();
    if (!cleanCode || cleanCode.length > 30) {
      throw new TeamError(400, 'Invalid course code');
    }
    if (!cleanName || cleanName.length > 100) {
      throw new TeamError(400, 'Invalid course name');
    }

    const res = await this.db.query<CourseRow>(
      'INSERT INTO courses (code, name) VALUES ($1, $2) RETURNING *',
      [cleanCode, cleanName]
    );
    return res.rows[0];
  }

  async createTeam(courseId: UUID, name: string, captainUserId: UUID, actor: Actor): Promise<TeamDto> {
    if(this.profile !== 'LAN_OFFLINE' || actor.scope !== 'FULL' || actor.role !== 'ADMIN') throw new TeamError(403,'LAN administrator required');
    const cleanName = name.trim();
    if (!cleanName || cleanName.length < 2 || cleanName.length > 50) {
      throw new TeamError(400, 'Invalid team name');
    }

    // In LAN_OFFLINE mode, only ADMIN assigns/creates teams
    if (actor.role !== 'ADMIN' && actor.userId !== captainUserId) {
      throw new TeamError(403, 'Forbidden team creation');
    }

    return this.db.withTransaction(async (client) => {
      await lockRosterAdmission(client);
      // Check captain exists
      const captainRes = await client.query<{ id: string; username: string; display_name: string }>(
        'SELECT id, username, display_name FROM users WHERE id = $1',
        [captainUserId]
      );
      const captain = captainRes.rows[0];
      if (!captain) {
        throw new TeamError(404, 'Captain user not found');
      }

      // Check course exists
      const courseRes = await client.query('SELECT id FROM courses WHERE id = $1', [courseId]);
      if (courseRes.rows.length === 0) {
        throw new TeamError(404, 'Course not found');
      }

      // Check name uniqueness per course
      const existingTeam = await client.query(
        'SELECT id FROM teams WHERE course_id = $1 AND name = $2',
        [courseId, cleanName]
      );
      if (existingTeam.rows.length > 0) {
        throw new TeamError(409, `Team with name "${cleanName}" already exists in this course`);
      }

      // Insert team
      const teamRes = await client.query<TeamRow>(
        `INSERT INTO teams (course_id, name, captain_user_id)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [courseId, cleanName, captainUserId]
      );
      const team = teamRes.rows[0];

      // Add captain membership
      await client.query(
        `INSERT INTO team_memberships (team_id, user_id, role)
         VALUES ($1, $2, 'CAPTAIN')`,
        [team.id, captainUserId]
      );

      return {
        id: team.id,
        courseId: team.course_id,
        name: team.name,
        captainUserId: team.captain_user_id,
        members: [
          {
            userId: captain.id,
            username: captain.username,
            displayName: captain.display_name,
            role: 'CAPTAIN',
          },
        ],
        createdAt: team.created_at.toISOString(),
      };
    });
  }

  async addMember(teamId: UUID, userId: UUID, actor: Actor): Promise<TeamDto> {
    if(this.profile !== 'LAN_OFFLINE' || actor.scope !== 'FULL' || actor.role !== 'ADMIN') throw new TeamError(403,'LAN administrator required');
    return this.db.withTransaction(async (client) => {
      await lockRosterAdmission(client);
      if(await rosterIsLocked(client,teamId)) throw new TeamError(409,'ROSTER_LOCKED: enrollment permanently freezes the roster');
      const teamRes = await client.query<TeamRow>('SELECT * FROM teams WHERE id = $1 FOR UPDATE', [teamId]);
      const team = teamRes.rows[0];
      if (!team) {
        throw new TeamError(404, 'Team not found');
      }

      if (actor.role !== 'ADMIN' && actor.userId !== team.captain_user_id) {
        throw new TeamError(403, 'Only team captain or ADMIN can add team members');
      }

      // Check user exists
      const userRes = await client.query('SELECT id FROM users WHERE id = $1', [userId]);
      if (userRes.rows.length === 0) {
        throw new TeamError(404, 'User not found');
      }

      // 01 §59/§66: one team per student per tournament. Membership is the other door into a field.
      const clash = await client.query<{ tournament_name: string; team_name: string }>(
        `SELECT t.name AS tournament_name, other.name AS team_name
           FROM tournament_entries mine
           JOIN tournament_entries theirs
             ON theirs.tournament_id = mine.tournament_id AND theirs.team_id <> mine.team_id
           JOIN team_memberships m ON m.team_id = theirs.team_id AND m.user_id = $2
           JOIN tournaments t ON t.id = mine.tournament_id
           JOIN teams other ON other.id = theirs.team_id
          WHERE mine.team_id = $1
          ORDER BY t.name
          LIMIT 1`,
        [teamId, userId]
      );
      const enrolledElsewhere = clash.rows[0];
      if (enrolledElsewhere) {
        throw new TeamError(
          409,
          `MEMBER_ALREADY_ENROLLED: this user already plays for '${enrolledElsewhere.team_name}' in '${enrolledElsewhere.tournament_name}'`
        );
      }

      // Check current members count
      const countRes = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM team_memberships WHERE team_id = $1',
        [teamId]
      );
      const currentCount = parseInt(countRes.rows[0].count, 10);
      if (currentCount >= 5) {
        throw new TeamError(409, 'Team has reached maximum allowed members (5)');
      }

      // Insert membership (unique constraint will catch duplicate)
      try {
        await client.query(
          `INSERT INTO team_memberships (team_id, user_id, role)
           VALUES ($1, $2, 'MEMBER')`,
          [teamId, userId]
        );
      } catch (err: unknown) {
        if (err && typeof err === 'object' && 'code' in err && err.code === '23505') {
          throw new TeamError(409, 'User is already a member of this team');
        }
        throw err;
      }

      return this.getTeam(teamId, client);
    });
  }

  async getTeam(teamId: UUID, client?: PoolClient): Promise<TeamDto> {
    const q = client ? client.query.bind(client) : this.db.query.bind(this.db);
    const teamRes = await q<TeamRow>('SELECT * FROM teams WHERE id = $1', [teamId]);
    const team = teamRes.rows[0];
    if (!team) {
      throw new TeamError(404, 'Team not found');
    }

    const membersRes = await q<{
      user_id: string;
      username: string;
      display_name: string;
      role: 'CAPTAIN' | 'MEMBER';
    }>(
      `SELECT tm.user_id, u.username, u.display_name, tm.role
       FROM team_memberships tm
       JOIN users u ON u.id = tm.user_id
       WHERE tm.team_id = $1
       ORDER BY tm.created_at ASC`,
      [teamId]
    );

    return {
      id: team.id,
      courseId: team.course_id,
      name: team.name,
      captainUserId: team.captain_user_id,
      tournamentId: (team as TeamRow & {tournament_id?:string}).tournament_id ?? undefined,
      closedAt: (team as TeamRow & {closed_at?:Date}).closed_at?.toISOString(),
      rosterLocked: (await q('SELECT 1 FROM tournament_entries WHERE team_id=$1 LIMIT 1',[teamId])).rows.length>0,
      members: membersRes.rows.map((m) => ({
        userId: m.user_id,
        username: m.username,
        displayName: m.display_name,
        role: m.role,
      })),
      createdAt: team.created_at.toISOString(),
    };
  }

  // --- TOURNAMENT ADMISSION SUBSTRATE (T2/S03) ---

  async createTournament(
    input: {
      courseId: UUID;
      name: string;
      format: 'SINGLE_ELIMINATION' | 'SWISS_PLAYOFF' | 'ROUND_ROBIN' | 'ELO_ARENA';
      maxTeams?: number;
      minTeamSize?: number;
      maxTeamSize?: number;
      isRated?: boolean;
    },
    actor: Actor
  ): Promise<TournamentSubstrateDto> {
    if (actor.role !== 'ADMIN') {
      throw new TeamError(403, 'Only ADMIN can create tournaments');
    }
    if (input.isRated !== undefined && typeof input.isRated !== 'boolean') throw new TeamError(400, 'isRated must be a boolean');

    const cleanName = input.name.trim();
    if (!cleanName || cleanName.length < 2 || cleanName.length > 100) {
      throw new TeamError(400, 'Invalid tournament name');
    }

    const maxTeams = input.maxTeams ?? 500;
    const minTeamSize = input.minTeamSize ?? 1;
    const maxTeamSize = input.maxTeamSize ?? 3;

    if (maxTeams < 1 || minTeamSize < 1 || maxTeamSize < minTeamSize || maxTeamSize > 5) {
      throw new TeamError(400, 'Invalid tournament constraints');
    }

    const res = await this.db.query<TournamentRow>(
      `INSERT INTO tournaments (course_id, name, format, max_teams, min_team_size, max_team_size, is_rated)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [input.courseId, cleanName, input.format, maxTeams, minTeamSize, maxTeamSize, input.isRated ?? false]
    );

    const t = res.rows[0];
    return {
      id: t.id,
      courseId: t.course_id,
      name: t.name,
      format: t.format,
      isRated: t.is_rated,
      globalRatingPolicy: 'ArenaContestRating/v1',
      state: t.state,
      version: t.version,
      rulesRevision: t.rules_revision,
      maxTeams: t.max_teams,
      minTeamSize: t.min_team_size,
      maxTeamSize: t.max_team_size,
      admittedTeamCount: 0,
      createdAt: t.created_at.toISOString(),
    };
  }

  async publishTournament(tournamentId: UUID, actor: Actor): Promise<TournamentSubstrateDto> {
    if (actor.role !== 'ADMIN') {
      throw new TeamError(403, 'Only ADMIN can publish tournaments');
    }
    const res = await this.db.query<TournamentRow>(
      `UPDATE tournaments
       SET state = 'PUBLISHED', updated_at = clock_timestamp(), version = version + 1
       WHERE id = $1 AND state = 'DRAFT'
       RETURNING *`,
      [tournamentId]
    );
    if (res.rows.length === 0) {
      throw new TeamError(409, 'Tournament not found or not in DRAFT state');
    }
    return this.getTournamentSubstrate(tournamentId);
  }

  async openRegistration(
    tournamentId: UUID,
    opensAt: Instant | undefined,
    closesAt: Instant | undefined,
    actor: Actor
  ): Promise<TournamentSubstrateDto> {
    if (actor.role !== 'ADMIN') {
      throw new TeamError(403, 'Only ADMIN can open registration');
    }

    const res = await this.db.query<TournamentRow>(
      `UPDATE tournaments
       SET state = 'REGISTRATION_OPEN',
           registration_opens_at = COALESCE($2::timestamptz, clock_timestamp()),
           registration_closes_at = $3::timestamptz,
           updated_at = clock_timestamp(),
           version = version + 1
       WHERE id = $1 AND state IN ('DRAFT', 'PUBLISHED')
       RETURNING *`,
      [tournamentId, opensAt, closesAt]
    );
    if (res.rows.length === 0) {
      throw new TeamError(409, 'Tournament not found or cannot transition to REGISTRATION_OPEN');
    }
    return this.getTournamentSubstrate(tournamentId);
  }

  async getTournamentSubstrate(tournamentId: UUID): Promise<TournamentSubstrateDto> {
    const res = await this.db.query<TournamentRow>('SELECT * FROM tournaments WHERE id = $1', [tournamentId]);
    const t = res.rows[0];
    if (!t) {
      throw new TeamError(404, 'Tournament not found');
    }

    const countRes = await this.db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM tournament_admissions WHERE tournament_id = $1',
      [tournamentId]
    );

    return {
      id: t.id,
      courseId: t.course_id,
      name: t.name,
      isRated: t.is_rated,
      globalRatingPolicy: 'ArenaContestRating/v1',
      format: t.format,
      state: t.state,
      version: t.version,
      rulesRevision: t.rules_revision,
      maxTeams: t.max_teams,
      minTeamSize: t.min_team_size,
      maxTeamSize: t.max_team_size,
      registrationOpensAt: t.registration_opens_at?.toISOString(),
      registrationClosesAt: t.registration_closes_at?.toISOString(),
      admittedTeamCount: parseInt(countRes.rows[0].count, 10),
      createdAt: t.created_at.toISOString(),
    };
  }
}
