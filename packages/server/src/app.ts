/**
 * Fastify REST API & WebSocket Streaming Server for OanTuTi Arena
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import * as fs from 'fs';
import * as path from 'path';
import { Database } from './db.js';
import { MatchService } from './match-service.js';
import { WebSocketHub } from './ws-hub.js';
import { TournamentService } from './tournament-service.js';

export interface ServerOptions {
  readonly dbLocation?: string;
  readonly mapsDir?: string;
  readonly replaysDir?: string;
}

export interface AppContext {
  readonly app: FastifyInstance;
  readonly db: Database;
  readonly matchService: MatchService;
  readonly wsHub: WebSocketHub;
  readonly tournamentService: TournamentService;
}

export async function createApp(options?: ServerOptions): Promise<AppContext> {
  const db = new Database(options?.dbLocation ?? ':memory:');
  const matchService = new MatchService(db, options?.mapsDir, options?.replaysDir);
  const wsHub = new WebSocketHub(matchService, db);
  const tournamentService = new TournamentService(db, matchService);

  // Seed default AI bots if missing
  // Seed default AI bots across supported languages
  const defaultBots = [
    {
      name: 'GreedyBot',
      language: 'TYPESCRIPT' as const,
      filePath: path.resolve(process.cwd(), 'bots/greedy-bot.ts'),
      sourceCode: '// Greedy Heuristic Bot',
    },
    {
      name: 'RandomBot',
      language: 'TYPESCRIPT' as const,
      filePath: path.resolve(process.cwd(), 'bots/random-bot.ts'),
      sourceCode: '// Random Uniform Move Bot',
    },
    {
      name: 'PythonStarterBot',
      language: 'PYTHON' as const,
      filePath: path.resolve(process.cwd(), 'sdk/python/starter_bot.py'),
      sourceCode: '# Python 3 Starter Bot',
    },
    {
      name: 'TsStarterBot',
      language: 'TYPESCRIPT' as const,
      filePath: path.resolve(process.cwd(), 'sdk/typescript/starter_bot.ts'),
      sourceCode: '// TypeScript Starter Bot',
    },
    {
      name: 'CppStarterBot',
      language: 'CPP' as const,
      filePath: path.resolve(process.cwd(), 'sdk/cpp/starter_bot.cpp'),
      sourceCode: '// C++20 Starter Bot',
    },
  ];

  for (const b of defaultBots) {
    if (!db.getBotByName(b.name)) {
      db.createBot({
        userId: 'usr_system',
        name: b.name,
        language: b.language,
        filePath: b.filePath,
        sourceCode: b.sourceCode,
      });
    }
  }

  const app = Fastify({ logger: false });

  await app.register(fastifyCors, {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  await app.register(fastifyWebsocket);

  // Health check
  app.get('/api/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // Maps
  app.get('/api/maps', async () => {
    return { maps: matchService.getAvailableMaps() };
  });

  app.get<{ Params: { id: string } }>('/api/maps/:id', async (req, reply) => {
    try {
      const map = matchService.getMapDescriptor(req.params.id);
      return map;
    } catch {
      reply.status(404);
      return { error: `Map "${req.params.id}" not found` };
    }
  });

  // Bots
  app.get('/api/bots', async () => {
    return { bots: db.listBots() };
  });

  app.post<{
    Body: {
      name: string;
      language: 'PYTHON' | 'TYPESCRIPT' | 'JAVASCRIPT' | 'CPP' | 'JAVA' | 'GO';
      sourceCode: string;
      filePath?: string;
    };
  }>('/api/bots', async (req, reply) => {
    const { name, language, sourceCode } = req.body;
    if (!name || !language || !sourceCode) {
      reply.status(400);
      return { error: 'Missing required bot fields (name, language, sourceCode)' };
    }

    let resolvedFilePath = req.body.filePath;
    if (!resolvedFilePath && sourceCode) {
      const botsDir = path.resolve(process.cwd(), 'storage/bots');
      if (!fs.existsSync(botsDir)) fs.mkdirSync(botsDir, { recursive: true });
      const ext = language === 'PYTHON' ? 'py' : language === 'CPP' ? 'cpp' : 'ts';
      const safeName = name.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
      const filename = `${safeName}_${Date.now()}.${ext}`;
      resolvedFilePath = path.join(botsDir, filename);
      fs.writeFileSync(resolvedFilePath, sourceCode);
    }

    try {
      const bot = db.createBot({
        userId: 'usr_system',
        name,
        language,
        sourceCode,
        filePath: resolvedFilePath,
      });
      return { bot };
    } catch (err) {
      reply.status(409);
      return { error: (err as Error).message };
    }
  });

  // Matches
  app.post<{
    Body: {
      mapId: string;
      whiteBotId: string;
      blackBotId: string;
      maxTurns?: number;
    };
  }>('/api/matches', async (req, reply) => {
    const { mapId, whiteBotId, blackBotId, maxTurns } = req.body;
    if (!mapId || !whiteBotId || !blackBotId) {
      reply.status(400);
      return { error: 'Missing required match parameters (mapId, whiteBotId, blackBotId)' };
    }

    try {
      const { matchId } = await matchService.startMatch({
        mapId,
        whiteBotId,
        blackBotId,
        maxTurns,
      });
      return { matchId, status: 'RUNNING' };
    } catch (err) {
      reply.status(400);
      return { error: (err as Error).message };
    }
  });

  app.get<{ Params: { id: string } }>('/api/matches/:id', async (req, reply) => {
    const match = db.getMatchById(req.params.id);
    if (!match) {
      reply.status(404);
      return { error: `Match "${req.params.id}" not found` };
    }

    const activeState = matchService.getActiveMatch(req.params.id);
    return {
      match,
      isLive: Boolean(activeState && !activeState.isFinished),
    };
  });

  app.get<{ Params: { id: string } }>('/api/matches/:id/replay', async (req, reply) => {
    const replayRow = db.getReplayByMatchId(req.params.id);
    if (!replayRow || !replayRow.replay_data) {
      reply.status(404);
      return { error: `Replay for match "${req.params.id}" not found` };
    }

    reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', `attachment; filename="${req.params.id}.oantuti"`)
      .send(Buffer.from(replayRow.replay_data));
  });

  // Leaderboard
  app.get('/api/leaderboard', async () => {
    return { leaderboard: db.getLeaderboard() };
  });

  // Tournaments
  app.get('/api/tournaments', async () => {
    return { tournaments: tournamentService.listTournaments() };
  });

  app.post<{
    Body: {
      name: string;
      format?: 'ROUND_ROBIN' | 'SWISS';
      mapId: string;
      botIds: string[];
      maxTurns?: number;
      doubleRound?: boolean;
    };
  }>('/api/tournaments', async (req, reply) => {
    const { name, format, mapId, botIds, maxTurns, doubleRound } = req.body;
    if (!name || !mapId || !Array.isArray(botIds) || botIds.length < 2) {
      reply.status(400);
      return { error: 'Missing required tournament fields (name, mapId, botIds with at least 2 bots)' };
    }

    try {
      const tournament = await tournamentService.createTournament({
        name,
        format,
        mapId,
        botIds,
        maxTurns,
        doubleRound,
      });
      return { tournament };
    } catch (err) {
      reply.status(400);
      return { error: (err as Error).message };
    }
  });

  app.get<{ Params: { id: string } }>('/api/tournaments/:id', async (req, reply) => {
    try {
      const details = tournamentService.getTournamentDetails(req.params.id);
      return details;
    } catch {
      reply.status(404);
      return { error: `Tournament "${req.params.id}" not found` };
    }
  });

  // Binary WebSocket Streaming Route
  app.get<{ Params: { matchId: string } }>(
    '/ws/matches/:matchId',
    { websocket: true },
    (socket, req) => {
      const matchId = req.params.matchId;
      wsHub.handleConnection(socket, matchId);
    }
  );

  return { app, db, matchService, wsHub, tournamentService };
}
