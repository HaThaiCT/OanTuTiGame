import type pg from 'pg';
import type { MapDescriptor } from '@oantuti/engine';
import type { CommandContext, UUID } from '@oantuti/protocol';
import type { PostgresDatabase } from '../persistence/db.js';
import { EliminationFormat } from './formats/elimination.js';
import { SwissFormat } from './formats/swiss.js';
import { RoundRobinFormat } from './formats/round-robin.js';
import { EloFormat } from './formats/elo.js';
import type { CompletedEncounterRecord, RoundSchedule, TeamEntry } from './formats/types.js';

export class TournamentSchedulerService {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly elimination: EliminationFormat = new EliminationFormat(),
    private readonly swiss: SwissFormat = new SwissFormat(),
    private readonly roundRobin: RoundRobinFormat = new RoundRobinFormat(),
    private readonly elo: EloFormat = new EloFormat()
  ) {}

  /**
   * Initializes Round 1 encounters and games upon tournament start.
   */
  async scheduleRound1(tournamentId: string, mapDescriptor: MapDescriptor): Promise<void> {
    await this.db.withTransaction(async (client) => {
      // 1. Fetch tournament format
      const tourneyRes = await client.query<{ format: string }>(
        'SELECT format FROM tournaments WHERE id = $1',
        [tournamentId]
      );
      if (tourneyRes.rows.length === 0) throw new Error(`Tournament not found: ${tournamentId}`);
      const format = tourneyRes.rows[0].format;

      // 2. Fetch eligible teams
      const entriesRes = await client.query<{ team_id: string; seed_ordinal: number }>(
        `SELECT team_id, seed_ordinal FROM tournament_entries
         WHERE tournament_id = $1 AND status = 'ELIGIBLE'
         ORDER BY seed_ordinal ASC`,
        [tournamentId]
      );

      const teams: TeamEntry[] = entriesRes.rows.map((r) => ({
        teamId: r.team_id,
        seedOrdinal: r.seed_ordinal ?? 1,
      }));

      if (teams.length < 2) {
        throw new Error(`Cannot schedule round 1: minimum 2 eligible teams required, found ${teams.length}`);
      }

      // 3. Generate initial schedule
      let schedule: RoundSchedule;
      if (format === 'SINGLE_ELIMINATION') {
        schedule = this.elimination.generateRound1(teams);
      } else if (format === 'SWISS_PLAYOFF') {
        schedule = this.swiss.generateRound1(teams);
      } else if (format === 'ROUND_ROBIN') {
        schedule = this.roundRobin.generateRound(teams, 1);
      } else if (format === 'ELO_ARENA') {
        schedule = this.elo.generateEpoch(teams, new Map(), new Set(), 1);
      } else {
        throw new Error(`Unsupported tournament format: ${format}`);
      }

      // 4. Persist schedule
      await this.persistSchedule(client, tournamentId, schedule, mapDescriptor);
    });
  }

  /**
   * Handles completion of a game, evaluates encounter score, and advances round if all completed.
   */
  async handleGameCompletion(gameId: string): Promise<void> {
    await this.db.withTransaction(async (client) => {
      // Find encounter for this game
      const gameRes = await client.query<{
        encounter_id: string;
        tournament_id: string;
        stage: string;
        round_ordinal: number;
        map_descriptor: MapDescriptor;
      }>(
        `SELECT g.encounter_id, e.tournament_id, e.stage, e.round_ordinal, g.map_descriptor
         FROM games g
         JOIN encounters e ON g.encounter_id = e.id
         WHERE g.id = $1`,
        [gameId]
      );

      if (gameRes.rows.length === 0) return;
      const { encounter_id, tournament_id, stage, round_ordinal, map_descriptor } = gameRes.rows[0];

      // Check if all games for this encounter are COMPLETED
      const allGamesRes = await client.query<{
        id: string;
        game_ordinal: number;
        white_team_id: string;
        black_team_id: string;
        status: string;
        winner: number | null;
      }>(
        `SELECT g.id, g.game_ordinal, g.white_team_id, g.black_team_id, g.status, rv.winner
         FROM games g
         LEFT JOIN accepted_results ar ON g.id = ar.game_id
         LEFT JOIN result_versions rv ON ar.result_version_id = rv.id
         WHERE g.encounter_id = $1
         ORDER BY g.game_ordinal ASC`,
        [encounter_id]
      );

      const allCompleted = allGamesRes.rows.every((g) => g.status === 'COMPLETED');
      if (!allCompleted) return;

      // Fetch encounter details
      const encRes = await client.query<{
        team_a_id: string;
        team_b_id: string | null;
      }>('SELECT team_a_id, team_b_id FROM encounters WHERE id = $1', [encounter_id]);

      const { team_a_id, team_b_id } = encRes.rows[0];
      if (!team_b_id) return; // Already a bye

      let winsA = 0;
      let winsB = 0;

      for (const g of allGamesRes.rows) {
        if (g.winner === 1) {
          // White won
          if (g.white_team_id === team_a_id) winsA++;
          else winsB++;
        } else if (g.winner === 2) {
          // Black won
          if (g.black_team_id === team_a_id) winsA++;
          else winsB++;
        }
      }

      let winnerTeamId: string | null = null;
      let pointsA = 1.0;
      let pointsB = 1.0;

      if (winsA > winsB) {
        winnerTeamId = team_a_id;
        pointsA = 3.0;
        pointsB = 0.0;
      } else if (winsB > winsA) {
        winnerTeamId = team_b_id;
        pointsA = 0.0;
        pointsB = 3.0;
      }

      // Update encounter
      await client.query(
        `UPDATE encounters
         SET status = 'COMPLETED',
             winner_team_id = $1,
             points_a = $2,
             points_b = $3
         WHERE id = $4`,
        [winnerTeamId, pointsA, pointsB, encounter_id]
      );

      // Check if all encounters in this round are completed
      const allEncRes = await client.query<{ status: string }>(
        `SELECT status FROM encounters
         WHERE tournament_id = $1 AND stage = $2 AND round_ordinal = $3`,
        [tournament_id, stage, round_ordinal]
      );

      const roundComplete = allEncRes.rows.every(
        (e) => e.status === 'COMPLETED' || e.status === 'BYE'
      );

      if (roundComplete) {
        await this.advanceRound(client, tournament_id, stage, round_ordinal, map_descriptor);
      }
    });
  }

  /**
   * Advances completed round to next round or finalizes tournament stage.
   */
  private async advanceRound(
    client: pg.PoolClient,
    tournamentId: string,
    stage: string,
    roundOrdinal: number,
    mapDescriptor: MapDescriptor
  ): Promise<void> {
    // 1. Mark round completed
    await client.query(
      `UPDATE tournament_rounds
       SET status = 'COMPLETED',
           sealed_at = clock_timestamp()
       WHERE tournament_id = $1 AND stage = $2 AND round_ordinal = $3`,
      [tournamentId, stage, roundOrdinal]
    );

    // 2. Fetch tournament format and all teams
    const tourneyRes = await client.query<{ format: string }>(
      'SELECT format FROM tournaments WHERE id = $1',
      [tournamentId]
    );
    const format = tourneyRes.rows[0].format;

    const entriesRes = await client.query<{ team_id: string; seed_ordinal: number }>(
      `SELECT team_id, seed_ordinal FROM tournament_entries
       WHERE tournament_id = $1 AND status = 'ELIGIBLE'
       ORDER BY seed_ordinal ASC`,
      [tournamentId]
    );
    const teams: TeamEntry[] = entriesRes.rows.map((r) => ({
      teamId: r.team_id,
      seedOrdinal: r.seed_ordinal ?? 1,
    }));

    // 3. Fetch completed encounters for this stage/tournament
    const encHistoryRes = await client.query<{
      id: string;
      round_ordinal: number;
      team_a_id: string;
      team_b_id: string | null;
      winner_team_id: string | null;
      points_a: string;
      points_b: string;
    }>(
      `SELECT id, round_ordinal, team_a_id, team_b_id, winner_team_id, points_a, points_b
       FROM encounters
       WHERE tournament_id = $1 AND stage = $2
       ORDER BY round_ordinal ASC, slot_ordinal ASC`,
      [tournamentId, stage]
    );

    const completedEncounters: CompletedEncounterRecord[] = encHistoryRes.rows.map((r) => ({
      encounterId: r.id,
      roundOrdinal: r.round_ordinal,
      teamAId: r.team_a_id,
      teamBId: r.team_b_id ?? undefined,
      winnerTeamId: r.winner_team_id ?? undefined,
      pointsA: parseFloat(r.points_a),
      pointsB: parseFloat(r.points_b),
    }));

    // 4. Format-specific branch
    if (format === 'SINGLE_ELIMINATION' || stage === 'PLAYOFF') {
      const nextSchedule = this.elimination.generateNextRound(completedEncounters, roundOrdinal, stage);
      if (!nextSchedule) {
        // Elimination bracket is complete!
        await client.query(
          `UPDATE tournaments SET state = 'PROVISIONAL', updated_at = clock_timestamp() WHERE id = $1`,
          [tournamentId]
        );
        await client.query(
          `INSERT INTO outbox_events (topic, payload) VALUES ($1, $2)`,
          ['TOURNAMENT_PROVISIONAL', JSON.stringify({ tournamentId, stage })]
        );
      } else {
        await this.persistSchedule(client, tournamentId, nextSchedule, mapDescriptor);
      }
    } else if (format === 'SWISS_PLAYOFF') {
      const totalSwissRounds = this.swiss.calculateRounds(teams.length);
      const standings = this.swiss.computeStandings(teams, completedEncounters);

      // Record standings snapshot
      for (const s of standings) {
        await client.query(
          `INSERT INTO standings_snapshots (
             tournament_id, stage, round_ordinal, team_id, rank, points,
             matches_played, wins, draws, losses, buchholz, sonneborn_berger
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (tournament_id, stage, round_ordinal, team_id) DO UPDATE
           SET rank = EXCLUDED.rank, points = EXCLUDED.points`,
          [
            tournamentId,
            stage,
            roundOrdinal,
            s.teamId,
            s.rank,
            s.points,
            s.matchesPlayed,
            s.wins,
            s.draws,
            s.losses,
            s.buchholz ?? 0,
            s.sonnebornBerger ?? 0,
          ]
        );
      }

      if (roundOrdinal < totalSwissRounds) {
        // Next Swiss round
        const nextSchedule = this.swiss.generateNextRound(teams, completedEncounters, roundOrdinal);
        await this.persistSchedule(client, tournamentId, nextSchedule, mapDescriptor);
      } else {
        // Swiss completed! Auto-qualify top T into PLAYOFF stage
        const cutoff = this.swiss.calculatePlayoffCutoff(teams.length);
        const topTeams = standings.slice(0, cutoff).map((s) => ({
          teamId: s.teamId,
          seedOrdinal: s.rank,
        }));

        // Mark qualified in standings
        for (const t of topTeams) {
          await client.query(
            `UPDATE standings_snapshots SET is_qualified = TRUE
             WHERE tournament_id = $1 AND stage = $2 AND round_ordinal = $3 AND team_id = $4`,
            [tournamentId, stage, roundOrdinal, t.teamId]
          );
        }

        const playoffRound1 = this.elimination.generateRound1(topTeams, 'PLAYOFF');
        await this.persistSchedule(client, tournamentId, playoffRound1, mapDescriptor);
      }
    } else if (format === 'ROUND_ROBIN') {
      const totalRounds = this.roundRobin.calculateTotalRounds(teams.length);
      const standings = this.roundRobin.computeStandings(teams, completedEncounters);

      for (const s of standings) {
        await client.query(
          `INSERT INTO standings_snapshots (
             tournament_id, stage, round_ordinal, team_id, rank, points,
             matches_played, wins, draws, losses
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (tournament_id, stage, round_ordinal, team_id) DO UPDATE
           SET rank = EXCLUDED.rank, points = EXCLUDED.points`,
          [tournamentId, stage, roundOrdinal, s.teamId, s.rank, s.points, s.matchesPlayed, s.wins, s.draws, s.losses]
        );
      }

      if (roundOrdinal < totalRounds) {
        const nextSchedule = this.roundRobin.generateRound(teams, roundOrdinal + 1);
        await this.persistSchedule(client, tournamentId, nextSchedule, mapDescriptor);
      } else {
        // RR complete
        await client.query(
          `UPDATE tournaments SET state = 'PROVISIONAL', updated_at = clock_timestamp() WHERE id = $1`,
          [tournamentId]
        );
        await client.query(
          `INSERT INTO outbox_events (topic, payload) VALUES ($1, $2)`,
          ['TOURNAMENT_PROVISIONAL', JSON.stringify({ tournamentId, stage })]
        );
      }
    } else if (format === 'ELO_ARENA') {
      const totalEpochs = this.elo.calculateEpochs(teams.length);

      // Compute and record Elo deltas for each encounter in this epoch
      const currentRatings = new Map<string, number>();
      for (const t of teams) currentRatings.set(t.teamId, this.elo.INITIAL_RATING);

      // Load previous ratings
      const prevEvents = await client.query<{ team_id: string; post_rating: string }>(
        `SELECT DISTINCT ON (team_id) team_id, post_rating
         FROM rating_events
         WHERE tournament_id = $1
         ORDER BY team_id, epoch DESC`,
        [tournamentId]
      );
      for (const r of prevEvents.rows) {
        currentRatings.set(r.team_id, parseFloat(r.post_rating));
      }

      const epochEncounters = completedEncounters.filter((e) => e.roundOrdinal === roundOrdinal);
      for (const enc of epochEncounters) {
        if (!enc.teamBId) continue;
        const rA = currentRatings.get(enc.teamAId) ?? this.elo.INITIAL_RATING;
        const rB = currentRatings.get(enc.teamBId) ?? this.elo.INITIAL_RATING;

        const deltas = this.elo.calculateDeltas(rA, rB, enc.pointsA, enc.pointsB);

        await client.query(
          `INSERT INTO rating_events (tournament_id, encounter_id, team_id, epoch, pre_rating, delta, post_rating)
           VALUES ($1, $2, $3, $4, $5, $6, $7),
                  ($1, $2, $8, $4, $9, $10, $11)
           ON CONFLICT (tournament_id, encounter_id, team_id) DO NOTHING`,
          [
            tournamentId,
            enc.encounterId,
            enc.teamAId,
            roundOrdinal,
            rA,
            deltas.deltaA,
            deltas.postRatingA,
            enc.teamBId,
            rB,
            deltas.deltaB,
            deltas.postRatingB,
          ]
        );

        currentRatings.set(enc.teamAId, deltas.postRatingA);
        currentRatings.set(enc.teamBId, deltas.postRatingB);
      }

      // Record standings
      const sortedRatings = Array.from(currentRatings.entries()).sort((a, b) => b[1] - a[1]);
      for (let i = 0; i < sortedRatings.length; i++) {
        const [teamId, rating] = sortedRatings[i];
        await client.query(
          `INSERT INTO standings_snapshots (
             tournament_id, stage, round_ordinal, team_id, rank, points, rating_elo
           ) VALUES ($1, $2, $3, $4, $5, 0, $6)
           ON CONFLICT (tournament_id, stage, round_ordinal, team_id) DO UPDATE
           SET rank = EXCLUDED.rank, rating_elo = EXCLUDED.rating_elo`,
          [tournamentId, stage, roundOrdinal, teamId, i + 1, rating]
        );
      }

      if (roundOrdinal < totalEpochs) {
        const playedPairs = new Set<string>();
        for (const e of completedEncounters) {
          if (e.teamBId) {
            playedPairs.add(`${e.teamAId}:${e.teamBId}`);
            playedPairs.add(`${e.teamBId}:${e.teamAId}`);
          }
        }
        const nextSchedule = this.elo.generateEpoch(teams, currentRatings, playedPairs, roundOrdinal + 1);
        await this.persistSchedule(client, tournamentId, nextSchedule, mapDescriptor);
      } else {
        // Elo complete
        await client.query(
          `UPDATE tournaments SET state = 'PROVISIONAL', updated_at = clock_timestamp() WHERE id = $1`,
          [tournamentId]
        );
        await client.query(
          `INSERT INTO outbox_events (topic, payload) VALUES ($1, $2)`,
          ['TOURNAMENT_PROVISIONAL', JSON.stringify({ tournamentId, stage })]
        );
      }
    }
  }

  /**
   * Atomically records a round schedule, creating encounters and 2 games per encounter.
   */
  private async persistSchedule(
    client: pg.PoolClient,
    tournamentId: string,
    schedule: RoundSchedule,
    mapDescriptor: MapDescriptor
  ): Promise<void> {
    // 1. Insert round record
    await client.query(
      `INSERT INTO tournament_rounds (tournament_id, stage, round_ordinal, status)
       VALUES ($1, $2, $3, 'RUNNING')
       ON CONFLICT (tournament_id, stage, round_ordinal) DO NOTHING`,
      [tournamentId, schedule.stage, schedule.roundOrdinal]
    );

    // 2. Insert encounters & games
    for (const p of schedule.pairings) {
      const encRes = await client.query<{ id: string }>(
        `INSERT INTO encounters (
           tournament_id, stage, round_ordinal, slot_ordinal,
           team_a_id, team_b_id, status, winner_team_id, points_a, points_b
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          tournamentId,
          schedule.stage,
          schedule.roundOrdinal,
          p.slotOrdinal,
          p.teamAId,
          p.teamBId ?? null,
          p.isBye ? 'BYE' : 'RUNNING',
          p.isBye ? p.teamAId : null,
          p.isBye ? 3.0 : 0.0,
          0.0,
        ]
      );

      const encounterId = encRes.rows[0].id;

      if (!p.isBye && p.teamBId) {
        // Game 1: Team A White, Team B Black
        await client.query(
          `INSERT INTO games (encounter_id, game_ordinal, white_team_id, black_team_id, map_descriptor, status)
           VALUES ($1, 1, $2, $3, $4, 'RUNNING')`,
          [encounterId, p.teamAId, p.teamBId, JSON.stringify(mapDescriptor)]
        );

        // Game 2: Team B White, Team A Black (Swapped sides!)
        await client.query(
          `INSERT INTO games (encounter_id, game_ordinal, white_team_id, black_team_id, map_descriptor, status)
           VALUES ($1, 2, $2, $3, $4, 'RUNNING')`,
          [encounterId, p.teamBId, p.teamAId, JSON.stringify(mapDescriptor)]
        );
      }
    }

    // 3. Emit outbox event
    await client.query(
      `INSERT INTO outbox_events (topic, payload)
       VALUES ($1, $2)`,
      [
        'ROUND_SCHEDULED',
        JSON.stringify({
          tournamentId,
          stage: schedule.stage,
          roundOrdinal: schedule.roundOrdinal,
          pairingsCount: schedule.pairings.length,
        }),
      ]
    );
  }
}
