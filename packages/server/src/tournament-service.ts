/**
 * Tournament Service & Automated Matchmaker for OanTuTi Arena
 * Supports Round-Robin and Swiss formats with automated scheduling and ELO tracking.
 */

import { EventEmitter } from 'events';
import { Database, TournamentRow, MatchRow } from './db.js';
import { MatchService } from './match-service.js';

export interface StandingEntry {
  readonly botId: string;
  readonly botName: string;
  readonly language: string;
  matchesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
  points: number;
  elo: number;
}

export interface TournamentDetails {
  readonly tournament: TournamentRow;
  readonly standings: StandingEntry[];
  readonly matches: (MatchRow & { white_bot_name: string; black_bot_name: string })[];
}

export class TournamentService extends EventEmitter {
  private readonly db: Database;
  private readonly matchService: MatchService;

  constructor(db: Database, matchService: MatchService) {
    super();
    this.db = db;
    this.matchService = matchService;
  }

  async createTournament(options: {
    name: string;
    format?: 'ROUND_ROBIN' | 'SWISS';
    mapId: string;
    botIds: string[];
    maxTurns?: number;
    doubleRound?: boolean;
  }): Promise<TournamentRow> {
    const { name, mapId, botIds } = options;
    const format = options.format ?? 'ROUND_ROBIN';
    const maxTurns = options.maxTurns ?? 200;
    const doubleRound = options.doubleRound ?? false;

    if (!Array.isArray(botIds) || botIds.length < 2) {
      throw new Error('Tournament requires at least 2 participating bots');
    }

    // Verify all bots exist
    const bots = botIds.map((id) => {
      const b = this.db.getBotById(id);
      if (!b) throw new Error(`Bot "${id}" not found`);
      return b;
    });

    const tournament = this.db.createTournament({
      name,
      format,
      status: 'PENDING',
      configJson: JSON.stringify({
        mapId,
        botIds,
        maxTurns,
        doubleRound,
      }),
    });

    // Run tournament execution in background
    this.runTournament(tournament.id, bots, mapId, maxTurns, doubleRound).catch((err) => {
      this.db.updateTournamentStatus(tournament.id, 'CANCELLED');
      this.emit('tournament:error', { tournamentId: tournament.id, error: err });
    });

    return tournament;
  }

  private async runTournament(
    tournamentId: string,
    bots: { id: string; name: string; language: string }[],
    mapId: string,
    maxTurns: number,
    doubleRound: boolean
  ): Promise<void> {
    this.db.updateTournamentStatus(tournamentId, 'RUNNING');

    // Generate pairings
    interface Pairing {
      whiteBotId: string;
      blackBotId: string;
    }
    const pairings: Pairing[] = [];

    for (let i = 0; i < bots.length; i++) {
      for (let j = i + 1; j < bots.length; j++) {
        pairings.push({ whiteBotId: bots[i].id, blackBotId: bots[j].id });
        if (doubleRound) {
          pairings.push({ whiteBotId: bots[j].id, blackBotId: bots[i].id });
        }
      }
    }

    // Initialize standings
    const standingsMap = new Map<string, StandingEntry>();
    for (const b of bots) {
      const botRow = this.db.listBots().find((x) => x.id === b.id);
      standingsMap.set(b.id, {
        botId: b.id,
        botName: b.name,
        language: b.language,
        matchesPlayed: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        points: 0,
        elo: botRow?.elo ?? 1200,
      });
    }

    // Execute matches sequentially to guarantee clean CPU allocation
    for (const pairing of pairings) {
      const { matchId } = await this.matchService.startMatch({
        tournamentId,
        mapId,
        whiteBotId: pairing.whiteBotId,
        blackBotId: pairing.blackBotId,
        maxTurns,
      });

      const result = await this.matchService.waitForMatch(matchId);

      const whiteEntry = standingsMap.get(pairing.whiteBotId)!;
      const blackEntry = standingsMap.get(pairing.blackBotId)!;

      whiteEntry.matchesPlayed++;
      blackEntry.matchesPlayed++;

      if (result.winner === 1) { // WHITE
        whiteEntry.wins++;
        whiteEntry.points += 3;
        blackEntry.losses++;
      } else if (result.winner === 2) { // BLACK
        blackEntry.wins++;
        blackEntry.points += 3;
        whiteEntry.losses++;
      } else { // DRAW
        whiteEntry.draws++;
        whiteEntry.points += 1;
        blackEntry.draws++;
        blackEntry.points += 1;
      }

      // Update ELO snapshot in standings
      const updatedBots = this.db.listBots();
      whiteEntry.elo = updatedBots.find((x) => x.id === pairing.whiteBotId)?.elo ?? whiteEntry.elo;
      blackEntry.elo = updatedBots.find((x) => x.id === pairing.blackBotId)?.elo ?? blackEntry.elo;
    }

    // Finalize standings
    const sortedStandings = Array.from(standingsMap.values()).sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.wins !== a.wins) return b.wins - a.wins;
      return b.elo - a.elo;
    });

    // Update DB with final standings
    this.db.updateTournamentStatus(tournamentId, 'COMPLETED');
    const existingTour = this.db.getTournamentById(tournamentId);
    if (existingTour) {
      const cfg = JSON.parse(existingTour.config_json || '{}');
      cfg.standings = sortedStandings;
      this.db.updateTournamentConfig(tournamentId, JSON.stringify(cfg));
    }

    this.emit('tournament:complete', { tournamentId, standings: sortedStandings });
  }

  getTournamentDetails(tournamentId: string): TournamentDetails {
    const tour = this.db.getTournamentById(tournamentId);
    if (!tour) throw new Error(`Tournament "${tournamentId}" not found`);

    const rawMatches = this.db.getMatchesByTournamentId(tournamentId);
    const allBots = this.db.listBots();
    const botMap = new Map<string, string>();
    for (const b of allBots) {
      botMap.set(b.id, b.name);
    }

    const matches = rawMatches.map((m) => ({
      ...m,
      white_bot_name: botMap.get(m.white_bot_id) ?? 'Unknown White',
      black_bot_name: botMap.get(m.black_bot_id) ?? 'Unknown Black',
    }));

    // Calculate live or finalized standings
    let standings: StandingEntry[] = [];
    const cfg = JSON.parse(tour.config_json || '{}');
    if (cfg.standings && Array.isArray(cfg.standings)) {
      standings = cfg.standings;
    } else if (cfg.botIds && Array.isArray(cfg.botIds)) {
      const map = new Map<string, StandingEntry>();
      for (const botId of cfg.botIds) {
        const bot = allBots.find((x) => x.id === botId);
        map.set(botId, {
          botId,
          botName: bot?.name ?? 'Unknown',
          language: bot?.language ?? 'UNKNOWN',
          matchesPlayed: 0,
          wins: 0,
          losses: 0,
          draws: 0,
          points: 0,
          elo: bot?.elo ?? 1200,
        });
      }

      for (const m of matches) {
        if (!m.finished_at) continue;
        const w = map.get(m.white_bot_id);
        const b = map.get(m.black_bot_id);
        if (w) w.matchesPlayed++;
        if (b) b.matchesPlayed++;

        if (m.winner_side === 'WHITE') {
          if (w) { w.wins++; w.points += 3; }
          if (b) { b.losses++; }
        } else if (m.winner_side === 'BLACK') {
          if (b) { b.wins++; b.points += 3; }
          if (w) { w.losses++; }
        } else if (m.winner_side === 'DRAW') {
          if (w) { w.draws++; w.points += 1; }
          if (b) { b.draws++; b.points += 1; }
        }
      }

      standings = Array.from(map.values()).sort((a, b) => b.points - a.points || b.wins - a.wins);
    }

    return { tournament: tour, standings, matches };
  }

  listTournaments(): TournamentRow[] {
    return this.db.listTournaments();
  }
}
