import type { PoolClient } from 'pg';

/** Every roster/admission writer takes this before tournament/team/user row locks. */
export async function lockRosterAdmission(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('oantuti:roster-admission',0))");
}

export async function rosterIsLocked(client: PoolClient, teamId: string): Promise<boolean> {
  const result = await client.query('SELECT 1 FROM tournament_entries WHERE team_id=$1 LIMIT 1',[teamId]);
  return result.rows.length > 0;
}
/** Checks the active roster invariant while the caller holds `lockRosterAdmission`. */
export async function hasActiveTournamentTeam(client: PoolClient, tournamentId: string, userId: string, exceptTeamId?: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM teams team JOIN team_memberships membership ON membership.team_id=team.id
     WHERE team.tournament_id=$1 AND team.closed_at IS NULL AND membership.user_id=$2
       AND ($3::uuid IS NULL OR team.id<>$3::uuid) LIMIT 1`,
    [tournamentId,userId,exceptTeamId ?? null]
  );
  return result.rows.length > 0;
}

/** Shared by direct admission and code redemption; caller already owns the global/tournament locks. */
export async function admissionRosterProblem(client: PoolClient, tournamentId: string, teamId: string): Promise<string | undefined> {
  const result=await client.query<{closed_at:Date|null; members:string; min_team_size:number; max_team_size:number; conflict:boolean}>(
    `SELECT team.closed_at,(SELECT count(*)::text FROM team_memberships WHERE team_id=team.id) AS members,
      t.min_team_size,t.max_team_size, EXISTS(
        SELECT 1 FROM team_memberships mine JOIN team_memberships other ON mine.user_id=other.user_id AND mine.team_id<>other.team_id
        JOIN tournament_entries entry ON entry.team_id=other.team_id
        WHERE mine.team_id=team.id AND entry.tournament_id=t.id
      ) AS conflict FROM teams team CROSS JOIN tournaments t WHERE team.id=$2 AND t.id=$1`,[tournamentId,teamId]);
  const row=result.rows[0];
  if(!row) return 'TEAM_NOT_FOUND';
  if(row.closed_at) return 'TEAM_CLOSED';
  if(Number(row.members)<row.min_team_size || Number(row.members)>row.max_team_size) return 'TEAM_SIZE_INVALID';
  if(row.conflict) return 'TEAM_MEMBER_ALREADY_ENROLLED';
  return undefined;
}
