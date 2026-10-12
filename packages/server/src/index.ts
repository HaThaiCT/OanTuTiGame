/**
 * Server Entrypoint for OanTuTi Arena
 */

import { createApp } from './app.js';

export * from './db.js';
export * from './match-service.js';
export * from './ws-hub.js';
export * from './app.js';

const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';

if (process.argv[1]?.endsWith('src/index.ts') || process.argv[1]?.endsWith('dist/index.js')) {
  createApp({
    dbLocation: process.env.DB_LOCATION,
    allowedOrigins: process.env.PUBLIC_ORIGINS?.split(',').map(origin => origin.trim()).filter(Boolean),
  })
    .then(async ({ app }) => {
      await app.listen({ port: PORT, host: HOST });
      process.stdout.write(`\n=======================================================\n`);
      process.stdout.write(`        OanTuTi Arena Game Server & WS Hub             \n`);
      process.stdout.write(`=======================================================\n`);
      process.stdout.write(`HTTP API:      http://${HOST}:${PORT}\n`);
      process.stdout.write(`WebSocket:     ws://${HOST}:${PORT}/ws/matches/:matchId\n`);
      process.stdout.write(`Ready to accept bot matches and spectator streams!\n`);
      process.stdout.write(`=======================================================\n\n`);
    })
    .catch((err) => {
      process.stderr.write(`Failed to start server: ${(err as Error).stack || err}\n`);
      process.exit(1);
    });
}
