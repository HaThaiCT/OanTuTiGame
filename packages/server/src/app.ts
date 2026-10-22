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
import { PostgresDatabase } from './persistence/db.js';
import { IdentityService } from './identity/service.js';
import { registerIdentityRoutes } from './identity/routes.js';
import { TeamError, TeamService } from './teams/service.js';
import { registerTeamRoutes } from './teams/routes.js';
import { ArtifactStore } from './submissions/artifact-store.js';
import { BuildPipeline } from './builds/build-pipeline.js';
import { CompiledArtifactStore } from './builds/compiled-artifact-store.js';
import { PrivateTestRunner } from './builds/private-test-runner.js';
import { PrivateTestResultService } from './builds/private-test-result-service.js';
import { SubmissionService } from './submissions/service.js';
import { registerSubmissionRoutes } from './submissions/routes.js';
import { ReplayStore } from './results/replay-store.js';
import { ResultService } from './results/service.js';
import { registerResultRoutes } from './results/routes.js';
import { MapValidator } from './tournaments/map-validator.js';
import { MapService } from './tournaments/map-service.js';
import { TournamentLifecycleService } from './tournaments/lifecycle-service.js';
import { TournamentAdmissionService } from './tournaments/admission-service.js';
import { TournamentEntryCodeService } from './tournaments/entry-code-service.js';
import { registerTournamentRoutes, registerAdmissionRoutes, registerExecutionRoutes, registerEntryCodeRoutes } from './tournaments/routes.js';
import { MatchExecutionService } from './tournaments/execution-service.js';
import { LiveMatchHub } from './live/live-match-hub.js';
import { registerLiveRoutes } from './live/live-routes.js';
import { TournamentAutoRunner } from './tournaments/auto-runner.js';
import { TournamentControlPlane } from './tournaments/control-plane.js';
import { JobBroker } from './jobs/broker.js';
import { JobReconciler } from './jobs/reconciler.js';
import { LocalJobBrokerTransport, type LocalJobBrokerOptions } from './jobs/local-transport.js';
import { NativeAssignmentService } from './jobs/native-assignment.js';
import { DisputeService } from './adjudication/dispute-service.js';
import { CorrectionService } from './adjudication/correction-service.js';
import { registerAdjudicationRoutes } from './adjudication/routes.js';
import { TournamentSchedulerService } from './tournaments/scheduler-service.js';
import { RetentionService } from './operations/retention-service.js';
import { BackupFence, backupFenceConfigFromEnv } from './operations/backup-fence.js';
import { readinessReport, type ReadinessInputs } from './operations/readiness.js';
import { registerOperationsRoutes } from './operations/routes.js';
import { resolveDeploymentGeneration } from './operations/backup-checkpoint.js';
import { NativeLiveProjector } from './live/native-live-projector.js';
import { registerGlobalRatingRoutes } from './ratings/routes.js';
import { GlobalTeamRatingService } from './ratings/service.js';

import { loadOnlineConfig, resolveAuthProfile, type OnlineConfig } from './identity/online-config.js';
import { MailConsumer, type MailTransport } from './identity/mail-consumer.js';
import { createSmtpTransport } from './identity/smtp-transport.js';
import type { IdentityMailOptions } from './identity/mail-outbox.js';
function toIdentityMailOptions(config: OnlineConfig): IdentityMailOptions {
  return { keyring: config.keyring, publicBaseUrl: config.publicBaseUrl, from: config.from, replyTo: config.replyTo };
}

export interface ServerOptions {
  readonly dbLocation?: string;
  readonly mapsDir?: string;
  readonly replaysDir?: string;
  readonly botsDir?: string;
  readonly allowedOrigins?: readonly string[];
  readonly pgDb?: PostgresDatabase;
  readonly onlineConfig?: OnlineConfig;
  readonly mailTransport?: MailTransport;
  readonly localJobBroker?: LocalJobBrokerOptions;
  readonly executionSpoolDir?: string;
}
export interface AppContext {
  readonly app: FastifyInstance;
  readonly db: Database;
  readonly matchService: MatchService;
  readonly wsHub: WebSocketHub;
  readonly tournamentService: TournamentService;
  readonly pgDb?: PostgresDatabase;
}
/**
 * Trusted proxy addresses for `request.ip`.
 *
 * Behind the LAN reverse proxy every socket carries the proxy's address, which would collapse the
 * per-IP login throttle into a single bucket shared by every client. The forwarded client address is
 * therefore honoured only when an operator names the proxies with `OANTUTI_TRUSTED_PROXIES`
 * (comma-separated addresses or CIDRs, e.g. `127.0.0.1`); leaving it unset keeps the socket address,
 * so no caller can pick its own throttle bucket with a spoofed `X-Forwarded-For`.
 */
function trustedProxies(env: NodeJS.ProcessEnv = process.env): string[] | false {
  const configured = (env.OANTUTI_TRUSTED_PROXIES ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return configured.length > 0 ? configured : false;
}

export async function createApp(options?: ServerOptions): Promise<AppContext> {
  if (options?.localJobBroker && !options.pgDb) throw new Error('Local job broker requires PostgreSQL');
  const authProfile = options?.onlineConfig ? 'ONLINE' : resolveAuthProfile();
  const onlineConfig = authProfile === 'ONLINE'
    ? options?.onlineConfig ?? loadOnlineConfig()
    : undefined;
  if (authProfile === 'ONLINE' && !onlineConfig) throw new Error('ONLINE startup requires a validated OnlineConfig');
  if (options?.onlineConfig && authProfile !== 'ONLINE') throw new Error('OnlineConfig is only valid with OANTUTI_AUTH_PROFILE=ONLINE');
  if (authProfile === 'ONLINE' && !options?.pgDb) throw new Error('ONLINE profile requires PostgreSQL');
  if (authProfile === 'ONLINE' && options?.mailTransport && !options.onlineConfig) throw new Error('Injected mail transport requires validated OnlineConfig');
  const trustedProxyConfig = authProfile === 'ONLINE'
    ? (onlineConfig!.trustedProxies.length ? [...onlineConfig!.trustedProxies] : false)
    : trustedProxies();
  let localJobBroker: LocalJobBrokerTransport | undefined;
  let mailConsumer: MailConsumer | undefined;
  let backupFence: BackupFence | undefined;
  let objectRootsProbe: ReadinessInputs['objectRoots'];
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

  const app = Fastify({ logger: false, trustProxy: trustedProxyConfig });
  const auth = new AuthService(db);
  const identityService = options?.pgDb ? new IdentityService(options.pgDb, authProfile, onlineConfig ? { mail: toIdentityMailOptions(onlineConfig), localDemoSkipEmailVerification: onlineConfig.localDemoSkipEmailVerification } : {}) : undefined;
  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof TeamError) return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    if (error instanceof HttpError) return reply.code(error.statusCode).send({ error: error.message });
    if (error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: 'Invalid request payload' });
    }
    return reply.code(500).send({ error: 'Internal server error' });
  });
  app.addHook('onRequest', async (request) => {
    const url = request.url.split('?')[0];
    if (['POST', 'PUT', 'DELETE'].includes(request.method) && ['/api/bots', '/api/matches', '/api/matches/test', '/api/tournaments'].some((route) => url === route || (route === '/api/bots' && url.startsWith('/api/bots/')))) auth.requireUser(request);
  });
  protectMutations(app, authProfile === 'ONLINE' ? onlineConfig!.allowedOrigins : options?.allowedOrigins ?? (process.env.NODE_ENV === 'production' ? [] : ['http://localhost:3000', 'http://127.0.0.1:3000']), { exactOrigin: true, allowCrossSiteForExactOrigin: authProfile === 'ONLINE' && onlineConfig!.localDemoSkipEmailVerification });
  if (!options?.pgDb) {
    auth.registerRoutes(app);
    registerBotRoutes(app, db, auth, options?.botsDir ?? path.resolve(process.cwd(), 'storage/bots'));
  }
  await app.register(fastifyWebsocket);
  if (options?.pgDb && identityService) {
    const teamService = new TeamService(options.pgDb, authProfile);
    if (authProfile === 'ONLINE') {
      const transport = options.mailTransport ?? createSmtpTransport(onlineConfig!.smtp);
      mailConsumer = new MailConsumer(options.pgDb, toIdentityMailOptions(onlineConfig!), transport);
      app.addHook('onReady', async () => { mailConsumer!.start(); });
      app.addHook('onClose', async () => { await mailConsumer!.stop(); });
    }
    const artifactStore = new ArtifactStore(
      options.pgDb,
      options.botsDir ?? path.resolve(process.cwd(), 'storage/submissions'),
      { ownedByConvention: !options.botsDir }
    );
    // Durable queue: intake/scheduler enqueue BUILD/GAME work, the worker claims/executes/
    // completes it, and the reconciler requeues expired leases. It is built before the
    // submission service, which enqueues the BUILD job for every accepted receipt.
    const deploymentGeneration = await resolveDeploymentGeneration(options.pgDb, options.localJobBroker?.deploymentGeneration);
    const jobBroker = new JobBroker(options.pgDb, deploymentGeneration);
    // The reconciler shares the generation: another deployment's leases and pinned completions are
    // deliberately out of its reach.
    const jobReconciler = new JobReconciler(options.pgDb, deploymentGeneration, jobBroker);
    backupFence = new BackupFence(options.pgDb, backupFenceConfigFromEnv());
    // A restored database names the roots it was captured from. Pointing a store somewhere else
    // starts cleanly and then serves 404s for evidence that is on disk, so readiness says so.
    objectRootsProbe = {
      async check() {
        for (const [table, root] of [['submission_sources', artifactStore.storageRoot], ['replay_objects', replayStore.storageRoot]] as const) {
          const escaped = root.replace(/[\\%_]/g, (character) => `\\${character}`);
          const stray = await options.pgDb!.query<{ storage_path: string }>(
            `SELECT storage_path FROM ${table} WHERE storage_path NOT LIKE $1 LIMIT 1`, [`${escaped}/%`]);
          if (stray.rows[0]) {
            return { ok: false, detail: `${table} references ${stray.rows[0].storage_path}, outside the configured root ${root}` };
          }
        }
        return { ok: true, detail: 'every recorded object path is inside the configured roots' };
      },
    };
    const acceptanceFence = backupFence;
    jobBroker.setAcceptanceFence((client) => acceptanceFence.assertFresh(client));
    const submissionService = new SubmissionService(options.pgDb, artifactStore, jobBroker, backupFence);
    // Replays must live under this workspace's storage, never a neighbouring install's default.
    const replayObjectsDir = options.replaysDir ?? path.resolve(process.cwd(), 'storage/replays');
    const replayStagingDir = path.resolve(process.cwd(), 'storage/replay-staging');
    const replayStore = new ReplayStore(replayObjectsDir, replayStagingDir, { storageOwnedByConvention: options.replaysDir === undefined, stagingOwnedByConvention: true });
    // Scratch root for the dev-only executors (the match executor and the private-test runner).
    const executionSpoolDir = options.executionSpoolDir ?? path.resolve(process.cwd(), 'storage/execution');
    // Private practice runs: real matches that touch no official table (migration 011).
    const privateTestRunner = new PrivateTestRunner(options.pgDb, artifactStore, replayStore, {
      spoolDir: path.join(executionSpoolDir, 'tests'),
    });
    registerIdentityRoutes(app, identityService, authProfile === 'ONLINE' ? onlineConfig!.allowedOrigins : options.allowedOrigins);
    registerTeamRoutes(app, teamService, identityService);
    registerSubmissionRoutes(app, submissionService, identityService, privateTestRunner);
    const resultService = new ResultService(options.pgDb, replayStore);
    registerResultRoutes(app, resultService, identityService);
    const mapService = new MapService(options.pgDb);
    const tournamentLifecycleService = new TournamentLifecycleService(options.pgDb, backupFence, async () => {
      if (process.env.OANTUTI_DEV_EXECUTION === '1') return;
      const capabilities = await localJobBroker?.capabilities();
      if (!localJobBroker?.isReady() || !capabilities?.officialGame || !capabilities.build || !capabilities.privateTest) {
        throw Object.assign(new Error('NATIVE_EXECUTION_NOT_READY: authenticated game and build workers are required'), { statusCode: 503 });
      }
    });
    const ratingService = new GlobalTeamRatingService(options.pgDb, backupFence);
    const tournamentAdmissionService = new TournamentAdmissionService(
      options.pgDb,
      async (tournamentId) => {
        await schedulerService.markTerminalRounds(tournamentId);
      },
      backupFence,
      ratingService,
      authProfile
    );
    const schedulerService = new TournamentSchedulerService(options.pgDb, jobBroker);
    // Immutable completion capsules live outside the attempt spool so a restarted process can still
    // accept a pinned completion; the operator may place them explicitly.
    const completionCapsuleRoot = options.localJobBroker
      ? options.localJobBroker.completionRoot ?? path.join(options.localJobBroker.spoolRoot, 'completions')
      : undefined;
    const liveMatchHub = new LiveMatchHub();
    registerLiveRoutes(app, liveMatchHub);
    // The native gateway is built last so it can hand the supervisor a server-built immutable
    // assignment and accept completions only through the same service that validates them.
    if (options.localJobBroker) {
      const assignments = new NativeAssignmentService(
        options.pgDb,
        artifactStore,
        resultService,
        schedulerService,
        jobBroker,
        // Private tests: the same snapshot state machine the dev runner walks, plus the verified
        // recording that keeps their outcome off every official table.
        new PrivateTestResultService(options.pgDb, replayStore),
        {
          runtimeProfileDigest: options.localJobBroker.runtimeProfileDigest,
          spoolRoot: options.localJobBroker.spoolRoot,
          toolchains: options.localJobBroker.toolchains,
          compiledArtifacts: new CompiledArtifactStore(options.localJobBroker.compiledArtifactsDir),
          liveProjector: new NativeLiveProjector(options.pgDb, liveMatchHub),
          completionRoot: completionCapsuleRoot,
        }
      );
      localJobBroker = new LocalJobBrokerTransport(options.pgDb, jobBroker, options.localJobBroker, assignments);
      const transport = localJobBroker;
      app.addHook('onReady', async () => { await transport.start(); });
      app.addHook('onClose', async () => { await transport.stop(); });
    }
    registerTournamentRoutes(
      app,
      options.pgDb,
      mapService,
      tournamentLifecycleService,
      schedulerService,
      identityService
    );
    registerAdmissionRoutes(app, tournamentAdmissionService, identityService);
    registerEntryCodeRoutes(app, new TournamentEntryCodeService(options.pgDb, authProfile), identityService);
    registerGlobalRatingRoutes(app, ratingService, identityService);
    // Compile + smoke-test gate: a receipt only becomes READY here.
    const buildPipeline = new BuildPipeline(options.pgDb, artifactStore, {
      spoolDir: path.join(executionSpoolDir, 'builds'),
    });
    // Public live spectator stream: the executor publishes each official game into this hub,
    // `GET /api/v2/live/:gameId` fans it out. Private practice tests never reach the executor,
    // so they are never published.
    // The same spectator projection is shared by native and development execution.
    // Development-only, unsandboxed executor: refuses to run unless OANTUTI_DEV_EXECUTION=1.
    const executionService = new MatchExecutionService(
      options.pgDb,
      mapService,
      artifactStore,
      replayStore,
      resultService,
      schedulerService,
      jobBroker,
      { spoolDir: executionSpoolDir },
      liveMatchHub
    );
    // Autonomous durable worker: inert unless OANTUTI_DEV_EXECUTION=1 (same flag as the executor).
    const retentionService = new RetentionService(options.pgDb);
    const controlPlane = new TournamentControlPlane(
      options.pgDb, jobBroker, jobReconciler, schedulerService, retentionService,
      undefined, undefined, completionCapsuleRoot, ratingService
    );
    app.addHook('onReady', async () => controlPlane.start());
    app.addHook('onClose', () => controlPlane.stop());
    app.addHook('onClose', async () => { await ratingService.stop(); });
    const autoRunner = new TournamentAutoRunner(
      options.pgDb,
      executionService,
      jobBroker,
      jobReconciler,
      buildPipeline,
      privateTestRunner,
      schedulerService,
      { retentionService, controlPlaneManaged: true }
    );
    registerExecutionRoutes(app, executionService, autoRunner, identityService);
    autoRunner.start();
    app.addHook('onClose', () => {
      autoRunner.stop();
      liveMatchHub.dispose();
    });
    const disputeService = new DisputeService(options.pgDb);
    const correctionService = new CorrectionService(options.pgDb, async (gameId) => {
      // Downstream invalidation is committed by the correction transaction.
      await schedulerService.handleGameCompletion(gameId);
    }, async (tournamentId, stage, roundOrdinal) => {
      // Disqualification voids encounters and rebuilds the schedule from the affected round.
      return schedulerService.invalidateAfterRound(tournamentId, stage, roundOrdinal);
    }, backupFence, async (gameId, client) => {
      await jobBroker.enqueueInTransaction(client, 'GAME', gameId, 100, { reason: 'REJUDGE' });
    });
    registerAdjudicationRoutes(app, disputeService, correctionService, identityService);
    registerOperationsRoutes(app, retentionService, identityService);
  }
  // Liveness: the process answers and its routes are mounted. It deliberately does not report the
  // execution plane — readiness does that, so a sandbox outage never looks like a dead API.
  app.get('/api/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  // Readiness: what this deployment can actually accept right now, with a reason per failing
  // check. Degraded answers 503 so an orchestrator withholds traffic while reads stay available.
  app.get('/api/health/ready', async (_request, reply) => {
    const report = await readinessReport({
      database: options?.pgDb,
      executionGateway: localJobBroker,
      devExecutorEnabled: process.env.OANTUTI_DEV_EXECUTION === '1',
      backupFence,
      objectRoots: objectRootsProbe,
      mail: authProfile === 'ONLINE' ? { configured: Boolean(onlineConfig && mailConsumer), running: Boolean(mailConsumer) } : undefined,
    });
    return reply.code(report.status === 'ready' ? 200 : 503).send(report);
  });

  // Legacy standalone applications have no PostgreSQL control plane. A v2 deployment exposes
  // only v2 routes; its separate SQLite account/session plane is never a compatibility backdoor.
  if (!options?.pgDb) {
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
    reply.header('Cache-Control', 'private, no-store');
    // This block only exists without PostgreSQL, where there is no v2 identity plane: the v1
    // administrator check is the only authority available, and it never serves anonymous replays.
    auth.requireAdmin(req);
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
  }

  return { app, db, matchService, wsHub, tournamentService, pgDb: options?.pgDb };
}
