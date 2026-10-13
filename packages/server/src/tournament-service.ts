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

export interface SwissPairingResult {
  pairings: Array<{ whiteBotId: string; blackBotId: string }>;
  byeBotId?: string;
}

export function generateSwissPairings(
  standings: StandingEntry[],
  previousPairs: ReadonlySet<string>,
  byeHistory: ReadonlySet<string> = new Set<string>()
): SwissPairingResult {
  const sorted = [...standings].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.wins !== a.wins) return b.wins - a.wins;
    return b.elo - a.elo;
  });

  let byeBotId: string | undefined;
  const pool = [...sorted];

  if (pool.length % 2 === 1) {
    let byeIndex = -1;
    for (let i = pool.length - 1; i >= 0; i--) {
      if (!byeHistory.has(pool[i].botId)) {
        byeIndex = i;
        break;
      }
    }
    if (byeIndex === -1) {
      byeIndex = pool.length - 1;
    }
    byeBotId = pool[byeIndex].botId;
    pool.splice(byeIndex, 1);
  }

  function findMatching(remaining: StandingEntry[]): Array<{ whiteBotId: string; blackBotId: string }> | null {
    if (remaining.length === 0) return [];

    const first = remaining[0];
    for (let i = 1; i < remaining.length; i++) {
      const candidate = remaining[i];
      const key1 = `${first.botId}:${candidate.botId}`;
      const key2 = `${candidate.botId}:${first.botId}`;

      if (!previousPairs.has(key1) && !previousPairs.has(key2)) {
        const nextRemaining = remaining.filter((_, idx) => idx !== 0 && idx !== i);
        const subResult = findMatching(nextRemaining);
        if (subResult !== null) {
          return [{ whiteBotId: first.botId, blackBotId: candidate.botId }, ...subResult];
        }
      }
    }

    return null;
  }

  const matched = findMatching(pool);
  const pairings: Array<{ whiteBotId: string; blackBotId: string }> = [];

  if (matched !== null) {
    pairings.push(...matched);
  } else {
    for (let i = 0; i < pool.length; i += 2) {
      if (i + 1 < pool.length) {
        pairings.push({ whiteBotId: pool[i].botId, blackBotId: pool[i + 1].botId });
      }
    }
  }

  return { pairings, byeBotId };
}

export class TournamentService extends EventEmitter {
  private readonly db: Database;
  private readonly matchService: MatchService;

  constructor(db: Database, matchService: MatchService) {
    super();
    this.db = db;
    this.matchService = matchService;
  }

  openRegistration(options: {creatorId:string;name:string;mapId:string;format:'ROUND_ROBIN'|'SWISS';maxTurns?:number}): TournamentRow {
    return this.db.createTournament({...options,status:'PENDING',configJson:JSON.stringify({mapId:options.mapId,format:options.format,maxTurns:options.maxTurns ?? 200,botIds:[],entries:[],registrationOpen:true})});
  }

  submitEntry(tournamentId:string,userId:string,botId:string): void {
    const tournament=this.db.getTournamentById(tournamentId);
    if(!tournament) throw new Error('Tournament not found');
    const config=JSON.parse(tournament.config_json);
    if(tournament.status!=='PENDING'||!config.registrationOpen) throw new Error('Registration is closed');
    const bot=this.db.getBotById(botId);
    if(config.entries.length>=64&&!config.entries.some((entry:{userId:string})=>entry.userId===userId)) throw new Error('Maximum 64 players');
    if(!bot||!bot.is_active||bot.user_id!==userId) throw new Error('Owned bot not found');
    const entries: {userId:string;botId:string;version:number}[]=config.entries;
    config.entries=[...entries.filter(entry=>entry.userId!==userId),{userId,botId,version:bot.version}];
    config.botIds=config.entries.map((entry:{botId:string})=>entry.botId);
    this.db.updateTournamentConfig(tournamentId,JSON.stringify(config));
  }

  lockRegistration(tournamentId:string,userId:string): void {
    const tournament=this.db.getTournamentById(tournamentId);
    if(!tournament||tournament.creator_id!==userId) throw new Error('Organizer required');
    const config=JSON.parse(tournament.config_json);
    if(tournament.status!=='PENDING'||!config.registrationOpen) throw new Error('Registration is closed');
    if(config.botIds.length<2) throw new Error('At least two players are required');
    const bots=config.botIds.map((id:string)=>{
      const bot=this.db.getBotById(id);
      if(!bot?.is_active) throw new Error('Submitted bot is unavailable');
      const entry=config.entries.find((submitted:{botId:string;version:number})=>submitted.botId===id);
      if(!entry||entry.version!==bot.version) throw new Error('Bot changed after submission; player must submit again');
      return bot;
    });
    config.registrationOpen=false;
    this.db.updateTournamentConfig(tournamentId,JSON.stringify(config));
    this.runTournament(tournamentId,bots,config.mapId,config.maxTurns,false,tournament.format as 'ROUND_ROBIN'|'SWISS').catch(error=>{
      this.db.updateTournamentStatus(tournamentId,'CANCELLED');
      this.emit('tournament:error',{tournamentId,error});
    });
  }

  async createTournament(options: {
    creatorId: string;
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
      creatorId: options.creatorId,
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
    this.runTournament(tournament.id, bots, mapId, maxTurns, doubleRound, format).catch((err) => {
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
    doubleRound: boolean,
    format: 'ROUND_ROBIN' | 'SWISS'
  ): Promise<void> {
    this.db.updateTournamentStatus(tournamentId, 'RUNNING');

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

    if (format === 'SWISS') {
      const totalRounds = Math.max(1, Math.min(bots.length - 1, Math.ceil(Math.log2(bots.length))));
      const previousPairs = new Set<string>();
      const byeHistory = new Set<string>();

      for (let r = 1; r <= totalRounds; r++) {
        const currentStandings = Array.from(standingsMap.values()).sort((a, b) => b.points - a.points || b.wins - a.wins);
        const { pairings, byeBotId } = generateSwissPairings(currentStandings, previousPairs, byeHistory);

        if (byeBotId) {
          const byeEntry = standingsMap.get(byeBotId)!;
          byeEntry.matchesPlayed++;
          byeEntry.wins++;
          byeEntry.points += 3;
          byeHistory.add(byeBotId);
        }

        for (const pairing of pairings) {
          previousPairs.add(`${pairing.whiteBotId}:${pairing.blackBotId}`);
          previousPairs.add(`${pairing.blackBotId}:${pairing.whiteBotId}`);

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

          if (result.winner === 1) {
            whiteEntry.wins++;
            whiteEntry.points += 3;
            blackEntry.losses++;
          } else if (result.winner === 2) {
            blackEntry.wins++;
            blackEntry.points += 3;
            whiteEntry.losses++;
          } else {
            whiteEntry.draws++;
            whiteEntry.points += 1;
            blackEntry.draws++;
            blackEntry.points += 1;
          }

          const updatedBots = this.db.listBots();
          whiteEntry.elo = updatedBots.find((x) => x.id === pairing.whiteBotId)?.elo ?? whiteEntry.elo;
          blackEntry.elo = updatedBots.find((x) => x.id === pairing.blackBotId)?.elo ?? blackEntry.elo;
        }
      }
    } else {
      // ROUND_ROBIN
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

        if (result.winner === 1) {
          whiteEntry.wins++;
          whiteEntry.points += 3;
          blackEntry.losses++;
        } else if (result.winner === 2) {
          blackEntry.wins++;
          blackEntry.points += 3;
          whiteEntry.losses++;
        } else {
          whiteEntry.draws++;
          whiteEntry.points += 1;
          blackEntry.draws++;
          blackEntry.points += 1;
        }

        const updatedBots = this.db.listBots();
        whiteEntry.elo = updatedBots.find((x) => x.id === pairing.whiteBotId)?.elo ?? whiteEntry.elo;
        blackEntry.elo = updatedBots.find((x) => x.id === pairing.blackBotId)?.elo ?? blackEntry.elo;
      }
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

  getTournamentDetails(tournamentId: string, projectedIndex?: number): TournamentDetails {
    const tour = this.db.getTournamentById(tournamentId);
    if (!tour) throw new Error(`Tournament "${tournamentId}" not found`);

    const rawMatches = this.db.getMatchesByTournamentId(tournamentId);
    const allBots = this.db.listBots();
    const botMap = new Map<string, string>();
    for (const b of allBots) {
      botMap.set(b.id, b.name);
    }

    const allMatches = rawMatches.map((m) => ({
      ...m,
      white_bot_name: botMap.get(m.white_bot_id) ?? 'Unknown White',
      black_bot_name: botMap.get(m.black_bot_id) ?? 'Unknown Black',
    }));

    const matches = projectedIndex !== undefined ? allMatches.slice(0, projectedIndex) : allMatches;

    const sanitizedTour = { ...tour };
    if (projectedIndex !== undefined && projectedIndex < allMatches.length) {
      try {
        const parsedCfg = JSON.parse(tour.config_json || '{}');
        delete parsedCfg.standings;
        sanitizedTour.config_json = JSON.stringify(parsedCfg);
      } catch {}
    }

    // Calculate live or finalized standings
    let standings: StandingEntry[] = [];
    const cfg = JSON.parse(tour.config_json || '{}');
    if ((projectedIndex === undefined || projectedIndex >= allMatches.length) && cfg.standings && Array.isArray(cfg.standings)) {
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

    return { tournament: sanitizedTour, standings, matches };
  }

  listTournaments(): TournamentRow[] {
    return this.db.listTournaments();
  }
}
