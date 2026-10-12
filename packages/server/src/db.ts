/**
 * Database Layer for OanTuTi Arena Server
 * Uses built-in node:sqlite (DatabaseSync) with schemas from docs/specs/05-DATA-MODELS-DATABASE-SPEC.md.
 */

import { createRequire } from 'node:module';
import * as crypto from 'node:crypto';

const req = createRequire(import.meta.url);
const { DatabaseSync } = req('node:sqlite');

export interface UserRow {
  readonly id: string;
  readonly username: string;
  readonly email: string;
  readonly password_hash: string;
  readonly role: 'USER' | 'ADMIN' | 'MODERATOR';
  readonly created_at: string;
  readonly updated_at: string;
}

export interface BotRow {
  readonly id: string;
  readonly user_id: string;
  readonly name: string;
  readonly language: 'PYTHON' | 'TYPESCRIPT' | 'JAVASCRIPT' | 'CPP' | 'JAVA' | 'GO';
  readonly source_code: string;
  readonly file_path?: string;
  readonly version: number;
  readonly is_active: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface LeaderboardEloRow {
  readonly id: string;
  readonly bot_id: string;
  readonly rating_elo: number;
  readonly matches_played: number;
  readonly wins: number;
  readonly losses: number;
  readonly draws: number;
  readonly peak_elo: number;
  readonly updated_at: string;
}
export interface TournamentRow {
  readonly id: string;
  readonly creator_id: string;
  readonly name: string;
  readonly format: 'SWISS' | 'ROUND_ROBIN' | 'SINGLE_ELIMINATION' | 'DOUBLE_ELIMINATION';
  readonly status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'CANCELLED';
  readonly config_json: string;
  readonly started_at?: string;
  readonly finished_at?: string;
  readonly created_at: string;
}

export interface MatchRow {
  readonly id: string;
  readonly tournament_id?: string;
  readonly map_id: string;
  readonly white_bot_id: string;
  readonly black_bot_id: string;
  readonly winner_bot_id?: string;
  readonly winner_side?: 'WHITE' | 'BLACK' | 'DRAW';
  readonly win_reason?: string;
  readonly total_turns: number;
  readonly started_at: string;
  readonly finished_at?: string;
}

export interface ReplayRow {
  readonly id: string;
  readonly match_id: string;
  readonly storage_type: 'DISK' | 'S3';
  readonly file_path: string;
  readonly file_size_bytes: number;
  readonly checksum_sha256: string;
  readonly replay_data?: Uint8Array;
  readonly created_at: string;
}

export class Database {
  private readonly db: DatabaseSync;

  constructor(location: string = ':memory:') {
    this.db = new DatabaseSync(location);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'USER' CHECK (role IN ('USER', 'ADMIN', 'MODERATOR')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        language TEXT NOT NULL CHECK (language IN ('PYTHON', 'TYPESCRIPT', 'JAVASCRIPT', 'CPP', 'JAVA', 'GO')),
        source_code TEXT NOT NULL,
        file_path TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(user_id, name)
      );

      CREATE TABLE IF NOT EXISTS leaderboard_elo (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL UNIQUE REFERENCES bots(id) ON DELETE CASCADE,
        rating_elo INTEGER NOT NULL DEFAULT 1200,
        matches_played INTEGER NOT NULL DEFAULT 0,
        wins INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0,
        draws INTEGER NOT NULL DEFAULT 0,
        peak_elo INTEGER NOT NULL DEFAULT 1200,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS tournaments (
        id TEXT PRIMARY KEY,
        creator_id TEXT NOT NULL REFERENCES users(id),
        name TEXT NOT NULL,
        format TEXT NOT NULL CHECK (format IN ('SWISS', 'ROUND_ROBIN', 'SINGLE_ELIMINATION', 'DOUBLE_ELIMINATION')),
        status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'CANCELLED')),
        config_json TEXT NOT NULL DEFAULT '{}',
        started_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY,
        tournament_id TEXT REFERENCES tournaments(id) ON DELETE SET NULL,
        map_id TEXT NOT NULL,
        white_bot_id TEXT NOT NULL REFERENCES bots(id),
        black_bot_id TEXT NOT NULL REFERENCES bots(id),
        winner_bot_id TEXT REFERENCES bots(id),
        winner_side TEXT CHECK (winner_side IN ('WHITE', 'BLACK', 'DRAW')),
        win_reason TEXT,
        total_turns INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS replays (
        id TEXT PRIMARY KEY,
        match_id TEXT NOT NULL UNIQUE REFERENCES matches(id) ON DELETE CASCADE,
        storage_type TEXT NOT NULL DEFAULT 'DISK' CHECK (storage_type IN ('DISK', 'S3')),
        file_path TEXT NOT NULL,
        file_size_bytes INTEGER NOT NULL,
        checksum_sha256 TEXT NOT NULL,
        replay_data BLOB,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Ensure system user exists
    const systemUser = this.getUserByUsername('system');
    if (!systemUser) {
      this.createUser({
        id: 'usr_system',
        username: 'system',
        email: 'system@oantuti.arena',
        password_hash: 'system_protected',
        role: 'ADMIN',
      });
    }
  }

  createUser(user: {
    id?: string;
    username: string;
    email: string;
    password_hash: string;
    role?: 'USER' | 'ADMIN' | 'MODERATOR';
  }): UserRow {
    const id = user.id ?? `usr_${crypto.randomUUID().slice(0, 8)}`;
    const role = user.role ?? 'USER';
    const stmt = this.db.prepare(`
      INSERT INTO users (id, username, email, password_hash, role)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(id, user.username, user.email, user.password_hash, role);
    return this.getUserById(id)!;
  }

  getUserById(id: string): UserRow | undefined {
    const stmt = this.db.prepare('SELECT * FROM users WHERE id = ?');
    return stmt.get(id) as UserRow | undefined;
  }

  getUserByUsername(username: string): UserRow | undefined {
    const stmt = this.db.prepare('SELECT * FROM users WHERE username = ?');
    return stmt.get(username) as UserRow | undefined;
  }

  createBot(bot: {
    id?: string;
    userId: string;
    name: string;
    language: 'PYTHON' | 'TYPESCRIPT' | 'JAVASCRIPT' | 'CPP' | 'JAVA' | 'GO';
    sourceCode: string;
    filePath?: string;
  }): BotRow {
    const id = bot.id ?? `bot_${crypto.randomUUID().slice(0, 8)}`;
    const stmt = this.db.prepare(`
      INSERT INTO bots (id, user_id, name, language, source_code, file_path)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, bot.userId, bot.name, bot.language, bot.sourceCode, bot.filePath ?? null);

    // Init ELO record
    const eloStmt = this.db.prepare(`
      INSERT INTO leaderboard_elo (id, bot_id, rating_elo, peak_elo)
      VALUES (?, ?, 1200, 1200)
    `);
    eloStmt.run(`elo_${crypto.randomUUID().slice(0, 8)}`, id);

    return this.getBotById(id)!;
  }

  getBotById(id: string): BotRow | undefined {
    const stmt = this.db.prepare('SELECT * FROM bots WHERE id = ?');
    return stmt.get(id) as BotRow | undefined;
  }

  getBotByName(name: string): BotRow | undefined {
    const stmt = this.db.prepare('SELECT * FROM bots WHERE name = ?');
    return stmt.get(name) as BotRow | undefined;
  }

  listBots(): (BotRow & { elo: number })[] {
    const stmt = this.db.prepare(`
      SELECT b.*, e.rating_elo as elo
      FROM bots b
      LEFT JOIN leaderboard_elo e ON b.id = e.bot_id
      WHERE b.is_active = 1
      ORDER BY e.rating_elo DESC
    `);
    return stmt.all() as (BotRow & { elo: number })[];
  }

  createMatch(match: {
    id?: string;
    tournamentId?: string;
    mapId: string;
    whiteBotId: string;
    blackBotId: string;
  }): MatchRow {
    const id = match.id ?? `match_${Date.now()}_${crypto.randomUUID().slice(0, 4)}`;
    const stmt = this.db.prepare(`
      INSERT INTO matches (id, tournament_id, map_id, white_bot_id, black_bot_id)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(id, match.tournamentId ?? null, match.mapId, match.whiteBotId, match.blackBotId);
    return this.getMatchById(id)!;
  }

  getMatchById(id: string): MatchRow | undefined {
    const stmt = this.db.prepare('SELECT * FROM matches WHERE id = ?');
    return stmt.get(id) as MatchRow | undefined;
  }

  updateMatchResult(
    id: string,
    result: {
      winnerBotId?: string;
      winnerSide: 'WHITE' | 'BLACK' | 'DRAW';
      winReason: string;
      totalTurns: number;
    }
  ): void {
    const stmt = this.db.prepare(`
      UPDATE matches
      SET winner_bot_id = ?, winner_side = ?, win_reason = ?, total_turns = ?, finished_at = datetime('now')
      WHERE id = ?
    `);
    stmt.run(result.winnerBotId ?? null, result.winnerSide, result.winReason, result.totalTurns, id);

    // Update ELO ratings
    const match = this.getMatchById(id);
    if (match) {
      this.updateEloRatings(match.white_bot_id, match.black_bot_id, result.winnerSide);
    }
  }

  saveReplay(replay: {
    id?: string;
    matchId: string;
    filePath: string;
    fileSizeBytes: number;
    checksumSha256: string;
    replayData?: Uint8Array;
  }): ReplayRow {
    const id = replay.id ?? `rep_${crypto.randomUUID().slice(0, 8)}`;
    const stmt = this.db.prepare(`
      INSERT INTO replays (id, match_id, storage_type, file_path, file_size_bytes, checksum_sha256, replay_data)
      VALUES (?, ?, 'DISK', ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      replay.matchId,
      replay.filePath,
      replay.fileSizeBytes,
      replay.checksumSha256,
      replay.replayData ?? null
    );
    return this.getReplayByMatchId(replay.matchId)!;
  }

  getReplayByMatchId(matchId: string): ReplayRow | undefined {
    const stmt = this.db.prepare('SELECT * FROM replays WHERE match_id = ?');
    return stmt.get(matchId) as ReplayRow | undefined;
  }

  getLeaderboard(): (LeaderboardEloRow & { bot_name: string; language: string })[] {
    const stmt = this.db.prepare(`
      SELECT e.*, b.name as bot_name, b.language
      FROM leaderboard_elo e
      JOIN bots b ON e.bot_id = b.id
      ORDER BY e.rating_elo DESC
    `);
    return stmt.all() as (LeaderboardEloRow & { bot_name: string; language: string })[];
  }

  private updateEloRatings(
    whiteBotId: string,
    blackBotId: string,
    winnerSide: 'WHITE' | 'BLACK' | 'DRAW'
  ): void {
    const whiteEloRow = this.getElo(whiteBotId);
    const blackEloRow = this.getElo(blackBotId);
    if (!whiteEloRow || !blackEloRow) return;

    const Ra = whiteEloRow.rating_elo;
    const Rb = blackEloRow.rating_elo;

    const Ea = 1 / (1 + Math.pow(10, (Rb - Ra) / 400));
    const Eb = 1 / (1 + Math.pow(10, (Ra - Rb) / 400));

    let Sa = 0.5;
    let Sb = 0.5;
    if (winnerSide === 'WHITE') {
      Sa = 1.0;
      Sb = 0.0;
    } else if (winnerSide === 'BLACK') {
      Sa = 0.0;
      Sb = 1.0;
    }

    const K = 32;
    const newRa = Math.round(Ra + K * (Sa - Ea));
    const newRb = Math.round(Rb + K * (Sb - Eb));

    this.saveElo(whiteBotId, newRa, Sa);
    this.saveElo(blackBotId, newRb, Sb);
  }

  private getElo(botId: string): LeaderboardEloRow | undefined {
    const stmt = this.db.prepare('SELECT * FROM leaderboard_elo WHERE bot_id = ?');
    return stmt.get(botId) as LeaderboardEloRow | undefined;
  }

  private saveElo(botId: string, newElo: number, score: number): void {
    const current = this.getElo(botId)!;
    const isWin = score === 1.0 ? 1 : 0;
    const isLoss = score === 0.0 ? 1 : 0;
    const isDraw = score === 0.5 ? 1 : 0;
    const peakElo = Math.max(current.peak_elo, newElo);

    const stmt = this.db.prepare(`
      UPDATE leaderboard_elo
      SET rating_elo = ?, peak_elo = ?, matches_played = matches_played + 1,
          wins = wins + ?, losses = losses + ?, draws = draws + ?,
          updated_at = datetime('now')
      WHERE bot_id = ?
    `);
    stmt.run(newElo, peakElo, isWin, isLoss, isDraw, botId);
  }

  createTournament(tournament: {
    id?: string;
    creatorId?: string;
    name: string;
    format: 'SWISS' | 'ROUND_ROBIN' | 'SINGLE_ELIMINATION' | 'DOUBLE_ELIMINATION';
    configJson?: string;
    status?: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'CANCELLED';
  }): TournamentRow {
    const id = tournament.id ?? `tour_${Date.now()}_${crypto.randomUUID().slice(0, 4)}`;
    const creatorId = tournament.creatorId ?? 'usr_system';
    const status = tournament.status ?? 'PENDING';
    const stmt = this.db.prepare(`
      INSERT INTO tournaments (id, creator_id, name, format, status, config_json, started_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    stmt.run(id, creatorId, tournament.name, tournament.format, status, tournament.configJson ?? '{}');
    return this.getTournamentById(id)!;
  }

  getTournamentById(id: string): TournamentRow | undefined {
    const stmt = this.db.prepare('SELECT * FROM tournaments WHERE id = ?');
    return stmt.get(id) as TournamentRow | undefined;
  }

  listTournaments(): TournamentRow[] {
    const stmt = this.db.prepare('SELECT * FROM tournaments ORDER BY created_at DESC');
    return stmt.all() as TournamentRow[];
  }

  updateTournamentStatus(id: string, status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'CANCELLED'): void {
    const isEnd = status === 'COMPLETED' || status === 'CANCELLED';
    const stmt = this.db.prepare(`
      UPDATE tournaments
      SET status = ?, finished_at = CASE WHEN ? THEN datetime('now') ELSE finished_at END
      WHERE id = ?
    `);
    stmt.run(status, isEnd ? 1 : 0, id);
  }

  updateTournamentConfig(id: string, configJson: string): void {
    const stmt = this.db.prepare('UPDATE tournaments SET config_json = ? WHERE id = ?');
    stmt.run(configJson, id);
  }

  getMatchesByTournamentId(tournamentId: string): MatchRow[] {
    const stmt = this.db.prepare('SELECT * FROM matches WHERE tournament_id = ? ORDER BY started_at ASC');
    return stmt.all(tournamentId) as MatchRow[];
  }

  close(): void {
    this.db.close();
  }
}
