/**
 * Server Entrypoint for OanTuTi Arena
 */

import { createApp } from './app.js';
import type { FastifyInstance } from 'fastify';
import { PostgresDatabase } from './persistence/db.js';
import { nativeGatewayConfig } from './jobs/runtime-config.js';
import { loadOnlineConfig } from './identity/online-config.js';
import { createSmtpTransport } from './identity/smtp-transport.js';

export * from './db.js';
export * from './match-service.js';
export * from './ws-hub.js';
export * from './app.js';
export { PostgresDatabase } from './persistence/db.js';
export * from './identity/service.js';
export * from './identity/routes.js';
export * from './teams/service.js';
export * from './teams/routes.js';
export * from './submissions/artifact-store.js';
export * from './submissions/source-materializer.js';
export * from './submissions/service.js';
export * from './submissions/routes.js';
export * from './builds/build-pipeline.js';
export * from './jobs/broker.js';
export * from './jobs/reconciler.js';
export * from './jobs/game-jobs.js';
export * from './jobs/identity.js';
export * from './results/replay-store.js';
export * from './results/trace-verifier.js';
export * from './results/service.js';
export * from './results/routes.js';
export * from './tournaments/map-validator.js';
export * from './tournaments/map-service.js';
export * from './tournaments/lifecycle-service.js';
export * from './tournaments/routes.js';
export * from './tournaments/formats/types.js';
export * from './tournaments/formats/elimination.js';
export * from './tournaments/formats/swiss.js';
export * from './tournaments/formats/round-robin.js';
export * from './tournaments/formats/elo.js';
export * from './tournaments/scheduler-service.js';
export * from './adjudication/dispute-service.js';
export * from './adjudication/correction-service.js';
export * from './adjudication/routes.js';

const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';

if (process.argv[1]?.endsWith('src/index.ts') || process.argv[1]?.endsWith('dist/index.js')) {
  const pgDb = new PostgresDatabase();
  let appContext: { readonly app: FastifyInstance } | undefined;
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { await appContext?.app.close(); }
    finally { await pgDb.close(); }
  };
  process.once('SIGTERM', () => { void shutdown().then(() => process.exit(0)); });
  process.once('SIGINT', () => { void shutdown().then(() => process.exit(0)); });
  const localJobBroker = nativeGatewayConfig();
  const onlineConfig = loadOnlineConfig();
  createApp({
    dbLocation: process.env.DB_LOCATION,
    allowedOrigins: process.env.PUBLIC_ORIGINS?.split(',').map(origin => origin.trim()).filter(Boolean),
    pgDb,
    ...(onlineConfig ? { onlineConfig, mailTransport: createSmtpTransport(onlineConfig.smtp) } : {}),
    localJobBroker,
    botsDir: process.env.OANTUTI_SUBMISSION_DIR,
    replaysDir: process.env.OANTUTI_REPLAYS_DIR,
    executionSpoolDir: process.env.OANTUTI_SPOOL_DIR,
  })
    .then(async (context) => {
      appContext = context;
      await context.app.listen({ port: PORT, host: HOST });
      process.stdout.write(`\n=======================================================\n`);
      process.stdout.write(`        OanTuTi Arena Game Server & WS Hub             \n`);
      process.stdout.write(`=======================================================\n`);
      process.stdout.write(`HTTP API:      http://${HOST}:${PORT}\n`);
      process.stdout.write(`Control plane:  /api/v2 (live spectator stream: /api/v2/live/:gameId)\n`);
      process.stdout.write(`Execution is dispatched to sandboxed workers; readiness reports what this build accepts.\n`);
      process.stdout.write(`=======================================================\n\n`);
    })
    .catch(async (err) => {
      process.stderr.write(`Failed to start server: ${(err as Error).stack || err}\n`);
      await shutdown();
      process.exitCode = 1;
    });
}
