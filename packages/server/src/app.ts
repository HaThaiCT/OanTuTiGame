/**
 * Fastify REST API & WebSocket Streaming Server for OanTuTi Arena
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import * as path from 'path';
import { Database } from './db.js';
import { MatchService } from './match-service.js';
import { WebSocketHub } from './ws-hub.js';
import { TournamentService } from './tournament-service.js';
import { AuthService, HttpError, botSourceFields, mapIdField, maxTurnsField, objectPayload, protectMutations, textField } from './auth.js';
import { migrateBotSourceFiles, registerBotRoutes } from './bot-routes.js';

export interface ServerOptions {
  readonly dbLocation?: string;
  readonly mapsDir?: string;
  readonly replaysDir?: string;
  readonly botsDir?: string;
  readonly allowedOrigins?: readonly string[];
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
    const existing = db.getOwnedBotByName('usr_system', b.name);
    if (existing && !existing.file_path) db.assignMigratedSourcePath(existing.id, existing.version, b.filePath);
    if (!db.getOwnedBotByName('usr_system', b.name)) {
      db.createBot({
        userId: 'usr_system',
        name: b.name,
        language: b.language,
        filePath: b.filePath,
        sourceCode: b.sourceCode,
      });
    }
  }
  migrateBotSourceFiles(db, options?.botsDir ?? path.resolve(process.cwd(), 'storage/bots'));

  const app = Fastify({ logger: false });
  const auth = new AuthService(db);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) return reply.code(error.statusCode).send({ error: error.message });
    if (error.statusCode && error.statusCode < 500) return reply.code(error.statusCode).send({ error: 'Invalid request payload' });
    return reply.code(500).send({ error: 'Internal server error' });
  });
  app.addHook('onRequest', async (request) => {
    const url = request.url.split('?')[0];
    if (['POST', 'PUT', 'DELETE'].includes(request.method) && ['/api/bots', '/api/matches', '/api/matches/test', '/api/tournaments'].some((route) => url === route || (route === '/api/bots' && url.startsWith('/api/bots/')))) auth.requireUser(request);
  });
  protectMutations(app, options?.allowedOrigins ?? (process.env.NODE_ENV === 'production' ? [] : ['http://localhost:3000', 'http://127.0.0.1:3000']));
  auth.registerRoutes(app);
  registerBotRoutes(app, db, auth, options?.botsDir ?? path.resolve(process.cwd(), 'storage/bots'));
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
    if (!/^[a-zA-Z0-9_-]+$/.test(req.params.id)) throw new HttpError(400, 'Invalid mapId');
    try {
      const map = matchService.getMapDescriptor(req.params.id);
      return map;
    } catch {
      reply.status(404);
      return { error: `Map "${req.params.id}" not found` };
    }
  });


  // Matches
  app.post('/api/matches', async (req) => {
    const user = auth.requireUser(req);
    const payload = objectPayload(req.body, ['mapId', 'whiteBotId', 'blackBotId', 'maxTurns']);
    const mapId = mapIdField(payload.mapId);
    const whiteBotId = textField(payload.whiteBotId, 'whiteBotId', 100);
    const blackBotId = textField(payload.blackBotId, 'blackBotId', 100);
    const maxTurns = maxTurnsField(payload.maxTurns);
    if (!matchService.getAvailableMaps().some((map) => map.id === mapId)) throw new HttpError(400, 'Map not found');
    if (![whiteBotId, blackBotId].every((id) => db.getBotById(id)?.is_active)) throw new HttpError(400, 'Active bot not found');
    try {
      const { matchId } = await matchService.startMatch({ mapId, whiteBotId, blackBotId, maxTurns });
      db.setMatchCreator(matchId, user.id);
      return { matchId, status: 'RUNNING' };
    } catch { throw new HttpError(400, 'Unable to start match'); }
  });

  app.post('/api/matches/test', async (req) => {
    auth.requireUser(req);
    const payload = objectPayload(req.body, ['mapId', 'opponentBotId', 'language', 'sourceCode', 'maxTurns']);
    const mapId = mapIdField(payload.mapId);
    const opponentBotId = textField(payload.opponentBotId, 'opponentBotId', 100);
    const { language, sourceCode } = botSourceFields({ ...payload, name: 'Draft' });
    const maxTurns = maxTurnsField(payload.maxTurns);
    if (!matchService.getAvailableMaps().some((map) => map.id === mapId)) throw new HttpError(400, 'Map not found');
    if (!db.getBotById(opponentBotId)?.is_active) throw new HttpError(400, 'Active opponent not found');
    try {
      const { matchId } = await matchService.startTestMatch({ mapId, opponentBotId, language, sourceCode, maxTurns });
      return { matchId, status: 'RUNNING' };
    } catch { throw new HttpError(400, 'Unable to start test match'); }
  });

  app.get<{ Params: { id: string } }>('/api/matches/:id', async (req) => {
    const match = db.getMatchById(req.params.id);
    const active = matchService.getActiveMatch(req.params.id);
    if (!match && !active) throw new HttpError(404, 'Match not found');
    return {
      match: match ?? { id: req.params.id, white_bot_name: active!.whiteBotName, black_bot_name: active!.blackBotName, total_turns: active!.deltaFrameBytes.length },
      isLive: Boolean(active && !active.isFinished),
      ...(active?.error ? { error: 'Match execution failed' } : {}),
    };
  });

  app.get<{ Params: { id: string } }>('/api/matches/:id/replay', async (req, reply) => {
    const replay = db.getReplayByMatchId(req.params.id)?.replay_data ?? matchService.getActiveMatch(req.params.id)?.replayBinary;
    if (!replay) throw new HttpError(404, 'Replay not found');
    return reply.header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', 'attachment; filename="match.oantuti"').send(Buffer.from(replay));
  });

  // Leaderboard
  app.get('/api/leaderboard', async () => {
    return { leaderboard: db.getLeaderboard() };
  });

  // Tournaments
  app.get('/api/tournaments', async (req) => {
    const user = auth.user(req);
    const list = tournamentService.listTournaments();
    if (user?.role === 'ADMIN') return { tournaments: list };
    return {
      tournaments: list.map((t) => {
        try {
          const cfg = JSON.parse(t.config_json || '{}');
          if (cfg.standings) {
            delete cfg.standings;
            return { ...t, config_json: JSON.stringify(cfg) };
          }
        } catch {}
        return t;
      }),
    };
  });

  app.post('/api/tournaments', async (req) => {
    const user = auth.requireAdmin(req);
    const payload = objectPayload(req.body, ['name', 'format', 'mapId', 'botIds', 'maxTurns', 'doubleRound', 'registrationOnly']);
    const name = textField(payload.name, 'name', 100).trim();
    const mapId = mapIdField(payload.mapId);
    const maxTurns = maxTurnsField(payload.maxTurns);
    if (payload.format !== undefined && payload.format !== 'ROUND_ROBIN' && payload.format !== 'SWISS') throw new HttpError(400, 'Invalid format');
    if (payload.doubleRound !== undefined && typeof payload.doubleRound !== 'boolean') throw new HttpError(400, 'Invalid doubleRound');
    if(payload.registrationOnly === true){
      if (!matchService.getAvailableMaps().some(map=>map.id===mapId)) throw new HttpError(400,'Map not found');
      return {tournament:tournamentService.openRegistration({creatorId:user.id,name,mapId,format:payload.format ?? 'SWISS',maxTurns})};
    }
    if (!Array.isArray(payload.botIds) || payload.botIds.length < 2 || payload.botIds.length > 64) throw new HttpError(400, 'Tournament requires at least 2 bots (maximum 64)');
    const botIds = payload.botIds.map((id: unknown) => textField(id, 'botId', 100));
    if (new Set(botIds).size !== botIds.length) throw new HttpError(400, 'Duplicate tournament bot');
    if (!botIds.every((id) => db.getBotById(id)?.is_active)) throw new HttpError(400, 'Active bot not found');
    if (!matchService.getAvailableMaps().some((map) => map.id === mapId)) throw new HttpError(400, 'Map not found');
    try {
      const tournament = await tournamentService.createTournament({ creatorId: user.id, name, mapId, botIds, maxTurns, format: payload.format, doubleRound: payload.doubleRound });
      return { tournament };
    } catch { throw new HttpError(400, 'Unable to start tournament'); }
  });

  app.post<{Params:{id:string}}>('/api/tournaments/:id/entries',async req=>{
    const user=auth.requireUser(req);
    const payload=objectPayload(req.body,['botId']);
    const botId=textField(payload.botId,'botId',100);
    const bot=db.getBotById(botId);
    if(!bot||bot.user_id!==user.id) throw new HttpError(404,'Owned bot not found');
    try{tournamentService.submitEntry(req.params.id,user.id,botId);}catch(error){throw new HttpError(409,error instanceof Error?error.message:'Entry rejected');}
    return tournamentService.getTournamentDetails(req.params.id);
  });
  app.post<{Params:{id:string}}>('/api/tournaments/:id/lock', async req => {
    const user = auth.requireAdmin(req);
    objectPayload(req.body, []);
    try { tournamentService.lockRegistration(req.params.id, user.id); } catch (error) { throw new HttpError(409, error instanceof Error ? error.message : 'Cannot lock registration'); }
    return tournamentService.getTournamentDetails(req.params.id);
  });

  app.post<{Params:{id:string}}>('/api/tournaments/:id/project-next', async (req, reply) => {
    auth.requireAdmin(req);
    objectPayload(req.body, []);
    try {
      const details = tournamentService.getTournamentDetails(req.params.id);
      const cfg = JSON.parse(details.tournament.config_json || '{}');
      const currentIndex = typeof cfg.projectedIndex === 'number' ? cfg.projectedIndex : 0;
      const nextIndex = details.matches.length > 0 ? Math.min(currentIndex + 1, details.matches.length) : currentIndex + 1;
      db.updateTournamentProjectedIndex(req.params.id, nextIndex);
      return { success: true, projectedIndex: nextIndex };
    } catch {
      reply.status(404);
      return { error: `Tournament "${req.params.id}" not found` };
    }
  });

  app.get<{ Params: { id: string } }>('/api/tournaments/:id', async (req, reply) => {
    try {
      const user = auth.user(req);
      if (user?.role === 'ADMIN') {
        return tournamentService.getTournamentDetails(req.params.id);
      }
      const raw = db.getTournamentById(req.params.id);
      if (!raw) {
        reply.status(404);
        return { error: `Tournament "${req.params.id}" not found` };
      }
      let projectedIndex = 0;
      try {
        const cfg = JSON.parse(raw.config_json || '{}');
        projectedIndex = typeof cfg.projectedIndex === 'number' ? cfg.projectedIndex : 0;
      } catch {
        projectedIndex = 0;
      }
      return tournamentService.getTournamentDetails(req.params.id, projectedIndex);
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
