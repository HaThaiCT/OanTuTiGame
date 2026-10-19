import type { PoolClient } from 'pg';
import type { ContestPlacement } from '@oantuti/protocol';

export class RatingPlacementError extends Error {
  constructor(readonly code: 'RATING_TOO_FEW_PARTICIPANTS' | 'RATING_NO_PLAYED_GAMES' | 'RATING_RESULTS_INCOMPLETE' | 'RATING_NO_FINAL_PLACEMENT') {
    super(code);
  }
}

export function compactPlacements(groups: readonly { readonly teamId: string; readonly group: number }[]): readonly ContestPlacement[] {
  const ordered = [...groups].sort((a, b) => a.group - b.group || a.teamId.localeCompare(b.teamId));
  const result: ContestPlacement[] = [];
  let index = 0;
  let rank = 1;
  while (index < ordered.length) {
    const group = ordered[index].group;
    let end = index + 1;
    while (end < ordered.length && ordered[end].group === group) end++;
    for (const entry of ordered.slice(index, end)) result.push({ teamId: entry.teamId as ContestPlacement['teamId'], rank, rankEnd: rank + end - index - 1, participation: 'PLACED' });
    rank += end - index;
    index = end;
  }
  return result;
}

export function mergeSwissPlayoffGroups(
  qualifierIds: readonly string[],
  playoffGroups: readonly { readonly teamId: string; readonly group: number }[],
  swissNonqualifiers: readonly { readonly teamId: string; readonly rank: number }[],
): readonly { teamId: string; group: number }[] {
  const qualifiers = new Set(qualifierIds);
  if (playoffGroups.some((row) => !qualifiers.has(row.teamId))) throw new RatingPlacementError('RATING_RESULTS_INCOMPLETE');
  const playoffMax = playoffGroups.reduce((maximum, row) => Math.max(maximum, row.group), -1);
  const swiss = swissNonqualifiers
    .filter((row) => !qualifiers.has(row.teamId))
    .sort((a, b) => a.rank - b.rank || a.teamId.localeCompare(b.teamId));
  const ranks = new Map<number, number>();
  let nextGroup = playoffMax + 1;
  for (const row of swiss) {
    if (!ranks.has(row.rank)) ranks.set(row.rank, nextGroup++);
  }
  return [...playoffGroups, ...swiss.map((row) => ({ teamId: row.teamId, group: ranks.get(row.rank)! }))];
}

type StructuralRound = { stage: string; round_ordinal: number; status: string; sealed_at: Date | null; slot_count: number };
type StructuralEncounter = { id: string; team_a_id: string; team_b_id: string | null; winner_team_id: string | null; round_ordinal: number; stage: string; slot_ordinal: number; status: string };

function knockoutGroups(rounds: readonly StructuralRound[], encounters: readonly StructuralEncounter[], field: ReadonlySet<string>, contenders: readonly string[]): readonly { teamId: string; group: number }[] {
  const ordered = [...rounds].sort((a, b) => a.round_ordinal - b.round_ordinal);
  if (!ordered.length) throw new RatingPlacementError('RATING_NO_FINAL_PLACEMENT');
  const losses = new Map<string, number>();
  let previous = new Map<number, StructuralEncounter>();
  const firstMembership = new Set<string>();
  for (let index = 0; index < ordered.length; index++) {
    const round = ordered[index];
    if (round.round_ordinal !== index + 1 || round.slot_count < 1
      || (round.slot_count & (round.slot_count - 1)) !== 0
      || (index > 0 && round.slot_count !== ordered[index - 1].slot_count / 2)) throw new RatingPlacementError('RATING_RESULTS_INCOMPLETE');
    const slots = new Map(encounters.filter((row) => row.round_ordinal === round.round_ordinal).map((row) => [row.slot_ordinal, row]));
    for (let slot = 1; slot <= round.slot_count; slot++) {
      const encounter = slots.get(slot);
      if (index > 0) {
        const a = previous.get(slot * 2 - 1)?.winner_team_id ?? null;
        const b = previous.get(slot * 2)?.winner_team_id ?? null;
        if (!a && !b) {
          if (encounter) throw new RatingPlacementError('RATING_RESULTS_INCOMPLETE');
          continue;
        }
        if (!encounter || encounter.team_a_id !== (a ?? b) || encounter.team_b_id !== (a && b ? b : null)) throw new RatingPlacementError('RATING_RESULTS_INCOMPLETE');
      }
      if (!encounter) continue; // Two structural EMPTY slots have no encounter row.
      for (const teamId of [encounter.team_a_id, encounter.team_b_id]) {
        if (!teamId) continue;
        if (!field.has(teamId) || (index === 0 && firstMembership.has(teamId))) throw new RatingPlacementError('RATING_RESULTS_INCOMPLETE');
        if (index === 0) firstMembership.add(teamId);
      }
      if (!encounter.team_b_id) {
        if (encounter.status !== 'BYE' || encounter.winner_team_id !== encounter.team_a_id) throw new RatingPlacementError('RATING_RESULTS_INCOMPLETE');
      } else {
        if (!encounter.winner_team_id) throw new RatingPlacementError('RATING_NO_FINAL_PLACEMENT');
        if (encounter.winner_team_id !== encounter.team_a_id && encounter.winner_team_id !== encounter.team_b_id) throw new RatingPlacementError('RATING_RESULTS_INCOMPLETE');
        losses.set(encounter.winner_team_id === encounter.team_a_id ? encounter.team_b_id : encounter.team_a_id, round.round_ordinal);
      }
    }
    previous = slots;
  }
  if (contenders.some((id) => !firstMembership.has(id))) throw new RatingPlacementError('RATING_RESULTS_INCOMPLETE');
  const final = previous.get(1);
  if (ordered.at(-1)!.slot_count !== 1 || !final?.winner_team_id || !contenders.includes(final.winner_team_id)) throw new RatingPlacementError('RATING_NO_FINAL_PLACEMENT');
  if (contenders.some((id) => id !== final.winner_team_id && !losses.has(id))) throw new RatingPlacementError('RATING_NO_FINAL_PLACEMENT');
  const lastRound = ordered.at(-1)!.round_ordinal;
  return contenders.map((teamId) => ({ teamId, group: teamId === final.winner_team_id ? 0 : lastRound - losses.get(teamId)! + 1 }));
}

function validateSnapshot<T extends { team_id: string; rank: number }>(rows: readonly T[], captured: ReadonlySet<string>, contenders: readonly string[]): Map<string, T> {
  const byId = new Map(rows.map((row) => [row.team_id, row]));
  if (byId.size !== rows.length || rows.some((row) => !captured.has(row.team_id) || !Number.isInteger(row.rank) || row.rank < 1)
    || contenders.some((id) => !byId.has(id))) throw new RatingPlacementError('RATING_RESULTS_INCOMPLETE');
  return byId;
}

/** Projects only the frozen rating field, never mutable admissions or current submissions. */
export async function projectContestPlacements(client: PoolClient, tournamentId: string): Promise<readonly ContestPlacement[]> {
  const tournament = await client.query<{ format: string }>('SELECT format FROM tournaments WHERE id = $1', [tournamentId]);
  if (!tournament.rows[0]) throw new RatingPlacementError('RATING_RESULTS_INCOMPLETE');
  const entries = await client.query<{ team_id: string; exclusion: string | null }>(
    `SELECT team_id, global_rating_exclusion AS exclusion FROM tournament_entries
     WHERE tournament_id = $1 AND global_rating_participant = true ORDER BY team_id`, [tournamentId]);
  if (new Set(entries.rows.map((row) => row.team_id)).size !== entries.rows.length) throw new RatingPlacementError('RATING_RESULTS_INCOMPLETE');
  const excluded = new Set(entries.rows.filter((row) => row.exclusion === 'PRESTART_EXCLUDED' || row.exclusion === 'DISQUALIFIED').map((row) => row.team_id));
  const active = entries.rows.filter((row) => !excluded.has(row.team_id));
  if (active.length < 2) throw new RatingPlacementError('RATING_TOO_FEW_PARTICIPANTS');
  const capturedIds = new Set(entries.rows.map((row) => row.team_id));
  const rounds = await client.query<StructuralRound>(
    `SELECT stage, round_ordinal, status, sealed_at, slot_count FROM tournament_rounds WHERE tournament_id = $1`, [tournamentId]);
  if (!rounds.rows.length || rounds.rows.some((row) => row.status !== 'COMPLETED' || !row.sealed_at || !Number.isInteger(row.slot_count) || row.slot_count < 0)) throw new RatingPlacementError('RATING_RESULTS_INCOMPLETE');
  const encounters = await client.query<StructuralEncounter>(
    `SELECT id, team_a_id, team_b_id, winner_team_id, round_ordinal, stage, slot_ordinal, status FROM encounters WHERE tournament_id = $1 AND status <> 'CANCELLED'`, [tournamentId]);
  const currentRound = new Map(rounds.rows.map((row) => [`${row.stage}:${row.round_ordinal}`, row]));
  if (currentRound.size !== rounds.rows.length) throw new RatingPlacementError('RATING_RESULTS_INCOMPLETE');
  const currentEncounters = encounters.rows;
  const slots = new Set<string>();
  const roundTeams = new Set<string>();
  for (const row of currentEncounters) {
    const round = currentRound.get(`${row.stage}:${row.round_ordinal}`);
    const key = `${row.stage}:${row.round_ordinal}:${row.slot_ordinal}`;
    if (!round || !Number.isInteger(row.slot_ordinal) || row.slot_ordinal < 1 || row.slot_ordinal > round.slot_count || slots.has(key)
      || !capturedIds.has(row.team_a_id) || (row.team_b_id !== null && (!capturedIds.has(row.team_b_id) || row.team_b_id === row.team_a_id))
      || !['COMPLETED', 'WALKOVER', 'DOUBLE_WITHDRAWAL', 'BYE'].includes(row.status)) throw new RatingPlacementError('RATING_RESULTS_INCOMPLETE');
    slots.add(key);
    for (const id of [row.team_a_id, row.team_b_id]) {
      if (id === null) continue;
      const teamKey = `${row.stage}:${row.round_ordinal}:${id}`;
      if (roundTeams.has(teamKey)) throw new RatingPlacementError('RATING_RESULTS_INCOMPLETE');
      roundTeams.add(teamKey);
    }
  }
  const format = tournament.rows[0].format;
  const allowedStages = format === 'SWISS_PLAYOFF' ? ['SWISS', 'PLAYOFF'] : ['MAIN'];
  if (rounds.rows.some((row) => !allowedStages.includes(row.stage))) throw new RatingPlacementError('RATING_RESULTS_INCOMPLETE');
  for (const stage of allowedStages) {
    const stageRounds = rounds.rows.filter((row) => row.stage === stage).sort((a, b) => a.round_ordinal - b.round_ordinal);
    if (stageRounds.some((row, index) => row.round_ordinal !== index + 1)) throw new RatingPlacementError('RATING_RESULTS_INCOMPLETE');
    if (format !== 'SINGLE_ELIMINATION' && stage !== 'PLAYOFF' && stageRounds.some((round) => currentEncounters.filter((row) => row.stage === stage && row.round_ordinal === round.round_ordinal).length !== round.slot_count)) throw new RatingPlacementError('RATING_RESULTS_INCOMPLETE');
  }
  const incompleteGames = await client.query(
    `SELECT 1 FROM encounters e LEFT JOIN games g ON g.encounter_id=e.id
     LEFT JOIN accepted_results a ON a.game_id=g.id
     WHERE e.tournament_id=$1 AND e.status <> 'CANCELLED'
       AND EXISTS (SELECT 1 FROM tournament_rounds r WHERE r.tournament_id=e.tournament_id AND r.stage=e.stage AND r.round_ordinal=e.round_ordinal)
       AND ((e.status='COMPLETED' AND NOT EXISTS (SELECT 1 FROM games played WHERE played.encounter_id=e.id AND played.status='COMPLETED'))
         OR g.status NOT IN ('COMPLETED','CANCELLED') OR (g.status='COMPLETED' AND a.game_id IS NULL)) LIMIT 1`, [tournamentId]);
  if (incompleteGames.rows.length) throw new RatingPlacementError('RATING_RESULTS_INCOMPLETE');
  const played = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM encounters e JOIN games g ON g.encounter_id = e.id JOIN accepted_results a ON a.game_id = g.id
      WHERE e.tournament_id = $1 AND e.status = 'COMPLETED'
        AND EXISTS (SELECT 1 FROM tournament_rounds r WHERE r.tournament_id=e.tournament_id AND r.stage=e.stage AND r.round_ordinal=e.round_ordinal)
        AND e.team_b_id IS NOT NULL AND e.team_a_id <> e.team_b_id
        AND e.team_a_id = ANY($2::uuid[]) AND e.team_b_id = ANY($2::uuid[])
        AND g.status = 'COMPLETED' AND ((g.white_team_id = e.team_a_id AND g.black_team_id = e.team_b_id) OR (g.white_team_id = e.team_b_id AND g.black_team_id = e.team_a_id))`, [tournamentId, [...capturedIds]]);
  if (Number(played.rows[0]?.count ?? 0) < 1) throw new RatingPlacementError('RATING_NO_PLAYED_GAMES');
  const withdrawn = active.filter((row) => row.exclusion === 'WITHDRAWN').map((row) => row.team_id);
  const contenders = active.filter((row) => row.exclusion !== 'WITHDRAWN').map((row) => row.team_id);
  let groups: readonly { teamId: string; group: number }[];
  if (format === 'SINGLE_ELIMINATION') {
    groups = knockoutGroups(rounds.rows.filter((row) => row.stage === 'MAIN'), currentEncounters, capturedIds, contenders);
  } else if (format === 'SWISS_PLAYOFF') {
    const swissRound = Math.max(0, ...rounds.rows.filter((row) => row.stage === 'SWISS').map((row) => row.round_ordinal));
    if (!swissRound) throw new RatingPlacementError('RATING_RESULTS_INCOMPLETE');
    const swiss = await client.query<{ team_id: string; rank: number; is_qualified: boolean }>(`SELECT team_id,rank,is_qualified FROM standings_snapshots WHERE tournament_id=$1 AND stage='SWISS' AND round_ordinal=$2 ORDER BY team_id`, [tournamentId, swissRound]);
    validateSnapshot(swiss.rows, capturedIds, contenders);
    const qualified = new Set(swiss.rows.filter((row) => row.is_qualified && contenders.includes(row.team_id)).map((row) => row.team_id));
    const playoff = currentEncounters.filter((row) => row.stage === 'PLAYOFF');
    const firstMembership = new Set(playoff.filter((row) => row.round_ordinal === 1).flatMap((row) => [row.team_a_id, row.team_b_id]).filter((id): id is string => id !== null && contenders.includes(id)));
    if (qualified.size !== firstMembership.size || [...qualified].some((id) => !firstMembership.has(id))
      || playoff.some((row) => [row.team_a_id, row.team_b_id].some((id) => id !== null && contenders.includes(id) && !qualified.has(id)))) throw new RatingPlacementError('RATING_RESULTS_INCOMPLETE');
    const playoffGroups = knockoutGroups(rounds.rows.filter((row) => row.stage === 'PLAYOFF'), playoff, capturedIds, [...qualified]);
    groups = mergeSwissPlayoffGroups([...qualified], playoffGroups, swiss.rows.filter((row) => contenders.includes(row.team_id)).map((row) => ({ teamId: row.team_id, rank: row.rank })));
  } else {
    if (format !== 'ROUND_ROBIN' && format !== 'ELO_ARENA') throw new RatingPlacementError('RATING_RESULTS_INCOMPLETE');
    const mainRound = Math.max(0, ...rounds.rows.filter((row) => row.stage === 'MAIN').map((row) => row.round_ordinal));
    if (!mainRound) throw new RatingPlacementError('RATING_RESULTS_INCOMPLETE');
    const snapshot = await client.query<{ team_id: string; rank: number; rating_elo: string | null }>(`SELECT team_id, rank, rating_elo FROM standings_snapshots WHERE tournament_id = $1 AND stage = 'MAIN' AND round_ordinal = $2 ORDER BY team_id`, [tournamentId, mainRound]);
    const byId = validateSnapshot(snapshot.rows, capturedIds, contenders);
    if (format === 'ELO_ARENA' && contenders.some((id) => byId.get(id)!.rating_elo === null || !Number.isFinite(Number(byId.get(id)!.rating_elo)))) throw new RatingPlacementError('RATING_RESULTS_INCOMPLETE');
    groups = contenders.map((teamId) => ({ teamId, group: format === 'ELO_ARENA' ? -Number(byId.get(teamId)!.rating_elo) : byId.get(teamId)!.rank }));
  }
  const placed = compactPlacements(groups);
  const withdrawnRank = placed.length + 1;
  return [...placed, ...withdrawn.sort().map((teamId) => ({ teamId: teamId as ContestPlacement['teamId'], rank: withdrawnRank, rankEnd: withdrawnRank + withdrawn.length - 1, participation: 'WITHDRAWN' as const }))];
}
