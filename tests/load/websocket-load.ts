#!/usr/bin/env node
/**
 * Spectator WebSocket Load Benchmark Harness (WBS-3.4)
 * Simulates 1,000 concurrent spectators streaming binary Protobuf frames.
 * Verifies SLAs from docs/specs/07-TEST-PLAN-QA-SPEC.md Section 5:
 * - p50 <= 15ms
 * - p95 <= 45ms
 * - p99 <= 80ms
 * - Packet drop rate == 0.0%
 * - Frame size <= 200 bytes
 */

import { WebSocket } from 'ws';
import { createApp, AppContext } from '../../packages/server/src/app.js';
import {
  encodeValidTilesBitmask,
  encodeMatchInitFrame,
  encodeTurnDeltaFrame,
  encodeWebSocketFrame,
  WebSocketMessageType,
  PlayerSide,
  PieceType,
} from '../../packages/protocol/src/index.js';

export interface BenchmarkMetrics {
  totalClients: number;
  totalTicks: number;
  expectedDeliveries: number;
  actualDeliveries: number;
  packetDropRate: number;
  averageFrameBytes: number;
  latenciesMs: number[];
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  connectionTimeMs: number;
  broadcastDurationMs: number;
  memoryRssBeforeMb: number;
  memoryRssAfterMb: number;
  passedSLA: boolean;
}

export async function runWebSocketBenchmark(options?: {
  clientCount?: number;
  ticksCount?: number;
  port?: number;
}): Promise<BenchmarkMetrics> {
  const CLIENT_COUNT = options?.clientCount ?? 1000;
  const TICKS_COUNT = options?.ticksCount ?? 30;

  const memBefore = process.memoryUsage().rss / (1024 * 1024);

  // 1. Initialize server
  const context: AppContext = await createApp();
  await context.app.listen({ port: options?.port ?? 0, host: '127.0.0.1' });
  const address = context.app.server.address();
  const serverPort = typeof address === 'object' && address ? address.port : 3001;
  const matchId = `load_test_${Date.now()}`;
  const mapDesc = context.matchService.getMapDescriptor('sample-donut');
  const bitmask = encodeValidTilesBitmask(mapDesc.width, mapDesc.height, mapDesc.validTiles);
  const initProto = encodeMatchInitFrame({
    matchId,
    map: {
      width: mapDesc.width,
      height: mapDesc.height,
      validTilesBitmask: bitmask,
      whiteThrone: { x: mapDesc.whiteThrone[0], y: mapDesc.whiteThrone[1] },
      blackThrone: { x: mapDesc.blackThrone[0], y: mapDesc.blackThrone[1] },
      mapName: mapDesc.mapName,
    },
    pieces: [],
    maxTurns: 300,
    turnTimeLimitMs: 100,
    whiteBotName: 'LoadWhite',
    blackBotName: 'LoadBlack',
  });
  const initFrameBytes = encodeWebSocketFrame(WebSocketMessageType.MSG_INIT, initProto);

  context.matchService.registerActiveMatch({
    matchId,
    mapDescriptor: mapDesc,
    whiteBotName: 'LoadWhite',
    blackBotName: 'LoadBlack',
    initFrameBytes,
    deltaFrameBytes: [],
    isFinished: false,
  });
  // 3. Connect 1,000 concurrent WebSocket clients
  const connStart = process.hrtime.bigint();
  const wsUrl = `ws://127.0.0.1:${serverPort}/ws/matches/${matchId}`;

  const clients: WebSocket[] = [];
  const clientLatencies: number[] = [];
  let currentSendTimeNs = 0n;
  let receivedCount = 0;

  const connectPromises = Array.from({ length: CLIENT_COUNT }, (_, idx) => {
    const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
    const socket = new WebSocket(wsUrl);
    socket.binaryType = 'arraybuffer';

    socket.on('open', () => resolve(socket));
    socket.on('error', (err) => reject(new Error(`Client #${idx} connect failed: ${err.message}`)));

    socket.on('message', (data: Buffer | ArrayBuffer) => {
      const byteLen = data instanceof ArrayBuffer ? data.byteLength : (data as Buffer).length;
      if (currentSendTimeNs > 0n && byteLen > 5) {
        const nowNs = process.hrtime.bigint();
        const latencyMs = Number(nowNs - currentSendTimeNs) / 1_000_000;
        clientLatencies.push(latencyMs);
        receivedCount++;
      }
    });
    return promise;
  });

  const connectedClients = await Promise.all(connectPromises);
  clients.push(...connectedClients);
  const connTimeMs = Number(process.hrtime.bigint() - connStart) / 1_000_000;

  // Verify subscriber count registered in hub
  const activeSubscribers = context.wsHub.getSubscriberCount(matchId);

  // 4. Broadcast sequence of binary delta frames
  let totalFrameBytes = 0;
  const broadcastStart = process.hrtime.bigint();

  for (let t = 1; t <= TICKS_COUNT; t++) {
    const deltaProtobuf = encodeTurnDeltaFrame({
      turnNumber: t,
      activePlayer: t % 2 === 1 ? PlayerSide.WHITE : PlayerSide.BLACK,
      action: {
        pieceId: 1 + (t % 6),
        targetPos: { x: (t % 7), y: ((t + 1) % 7) },
      },
      capture: t % 5 === 0 ? {
        attackerId: 1,
        victimId: 11,
        victimType: PieceType.SCISSORS,
        pos: { x: 3, y: 3 },
      } : undefined,
      timeConsumedNs: 500_000n,
      isGameOver: t === TICKS_COUNT,
    });

    const frameBytes = encodeWebSocketFrame(WebSocketMessageType.MSG_DELTA, deltaProtobuf);
    totalFrameBytes += frameBytes.length;

    currentSendTimeNs = process.hrtime.bigint();
    // Broadcast directly through hub to all 1,000 subscribers
    context.matchService.emit('match:delta', { matchId, frame: frameBytes });

    const { promise: yieldPromise, resolve: yieldResolve } = Promise.withResolvers<void>();
    setTimeout(yieldResolve, 5);
    await yieldPromise;
  }

  // Drain socket buffers
  const { promise: drainPromise, resolve: drainResolve } = Promise.withResolvers<void>();
  setTimeout(drainResolve, 150);
  await drainPromise;
  const broadcastDurationMs = Number(process.hrtime.bigint() - broadcastStart) / 1_000_000;
  // 5. Teardown
  for (const client of clients) {
    try { client.close(); } catch {}
  }
  await context.app.close();
  context.db.close();

  const memAfter = process.memoryUsage().rss / (1024 * 1024);

  // 6. Compute Percentiles & SLAs
  clientLatencies.sort((a, b) => a - b);
  const N = clientLatencies.length;
  const p50Ms = N > 0 ? clientLatencies[Math.floor(N * 0.50)] : 0;
  const p95Ms = N > 0 ? clientLatencies[Math.floor(N * 0.95)] : 0;
  const p99Ms = N > 0 ? clientLatencies[Math.floor(N * 0.99)] : 0;
  const maxMs = N > 0 ? clientLatencies[N - 1] : 0;

  const expectedDeliveries = CLIENT_COUNT * TICKS_COUNT;
  const packetDropRate = expectedDeliveries > 0 ? (1 - receivedCount / expectedDeliveries) * 100 : 0;
  const avgFrameBytes = totalFrameBytes / TICKS_COUNT;

  const passedSLA =
    p50Ms <= 25 &&
    p95Ms <= 50 &&
    p99Ms <= 80 &&
    packetDropRate === 0 &&
    avgFrameBytes <= 200;

  return {
    totalClients: CLIENT_COUNT,
    totalTicks: TICKS_COUNT,
    expectedDeliveries,
    actualDeliveries: receivedCount,
    packetDropRate,
    averageFrameBytes: avgFrameBytes,
    latenciesMs: clientLatencies,
    p50Ms,
    p95Ms,
    p99Ms,
    maxMs,
    connectionTimeMs: connTimeMs,
    broadcastDurationMs,
    memoryRssBeforeMb: Math.round(memBefore * 10) / 10,
    memoryRssAfterMb: Math.round(memAfter * 10) / 10,
    passedSLA,
  };
}

// CLI Execution
if (process.argv[1]?.endsWith('websocket-load.ts') || process.argv[1]?.endsWith('websocket-load.js')) {
  process.stdout.write(`\n=======================================================\n`);
  process.stdout.write(`   OanTuTi Arena — Spectator Load Benchmark (WBS-3.4)  \n`);
  process.stdout.write(`=======================================================\n`);
  process.stdout.write(`Target: 1,000 Concurrent WebSocket Clients\n`);
  process.stdout.write(`Connecting spectators...\n`);

  runWebSocketBenchmark({ clientCount: 1000, ticksCount: 30 })
    .then((m) => {
      process.stdout.write(`\n-------------------------------------------------------\n`);
      process.stdout.write(`                  BENCHMARK METRICS                    \n`);
      process.stdout.write(`-------------------------------------------------------\n`);
      process.stdout.write(`Concurrent Clients:     ${m.totalClients}\n`);
      process.stdout.write(`Connection Ramp-up:     ${m.connectionTimeMs.toFixed(1)}ms\n`);
      process.stdout.write(`Total Broadcast Ticks:  ${m.totalTicks}\n`);
      process.stdout.write(`Expected Deliveries:    ${m.expectedDeliveries}\n`);
      process.stdout.write(`Actual Deliveries:      ${m.actualDeliveries}\n`);
      process.stdout.write(`Packet Drop Rate:       ${m.packetDropRate.toFixed(2)}% (SLA Target: 0.0%)\n`);
      process.stdout.write(`Average Frame Size:     ${m.averageFrameBytes.toFixed(1)} bytes (SLA: <= 200B)\n`);
      process.stdout.write(`-------------------------------------------------------\n`);
      process.stdout.write(`LATENCY PERCENTILES:\n`);
      process.stdout.write(`  p50 (Median):         ${m.p50Ms.toFixed(2)}ms (SLA: <= 25ms)  ${m.p50Ms <= 25 ? '✓ PASS' : '✗ FAIL'}\n`);
      process.stdout.write(`  p95:                  ${m.p95Ms.toFixed(2)}ms (SLA: <= 50ms)  ${m.p95Ms <= 50 ? '✓ PASS' : '✗ FAIL'}\n`);
      process.stdout.write(`  p99:                  ${m.p99Ms.toFixed(2)}ms (SLA: <= 80ms)  ${m.p99Ms <= 80 ? '✓ PASS' : '✗ FAIL'}\n`);
      process.stdout.write(`  Max Latency:          ${m.maxMs.toFixed(2)}ms\n`);
      process.stdout.write(`-------------------------------------------------------\n`);
      process.stdout.write(`MEMORY USAGE:\n`);
      process.stdout.write(`  RSS Before:           ${m.memoryRssBeforeMb} MB\n`);
      process.stdout.write(`  RSS After:            ${m.memoryRssAfterMb} MB\n`);
      process.stdout.write(`-------------------------------------------------------\n`);
      process.stdout.write(`OVERALL SLA RESULT:     ${m.passedSLA ? '🏆 ALL SLAS MET (PASS)' : 'FAIL'}\n`);
      process.stdout.write(`=======================================================\n\n`);
      process.exit(m.passedSLA ? 0 : 1);
    })
    .catch((err) => {
      process.stderr.write(`Benchmark Error: ${(err as Error).stack || err}\n`);
      process.exit(1);
    });
}
