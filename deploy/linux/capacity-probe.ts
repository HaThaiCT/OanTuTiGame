#!/usr/bin/env npx tsx
/**
 * Development-host capacity probe (S16 partial evidence).
 *
 * Runs the spectator WebSocket benchmark in-process and reports the measured numbers together with
 * the host they were taken on. This is a **development-host measurement**, not release evidence: the
 * plan requires the same workload on the declared GA 6.8 release target, with the official/builder
 * pools, sandbox and storage in place. Nothing here certifies capacity, isolation or SLO compliance.
 *
 * Usage:
 *   npx tsx deploy/linux/capacity-probe.ts [--clients N] [--ticks N] [--out PATH]
 *
 * Exit code: 0 when the probe ran (regardless of the SLA verdict in the payload), 2 on usage error.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg, cpus, freemem, totalmem, platform, release, arch } from 'node:os';
import { resolve } from 'node:path';

import type { MapDescriptor } from '@oantuti/engine';

import { MatchOrchestrator } from '../../packages/runner/src/orchestrator.js';
import { runWebSocketBenchmark } from '../../tests/load/websocket-load.js';
import sampleMap from '../../docs/specs/maps/sample-donut.map.json';

interface Options {
  readonly clients: number;
  readonly ticks: number;
  /** Number of official-style matches to play for the execution-throughput section (0 = skip). */
  readonly games: number;
  readonly out: string | null;
}

class UsageError extends Error {}

function parseOptions(argv: readonly string[]): Options {
  let clients = 500;
  let ticks = 30;
  let games = 0;
  let out: string | null = null;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const [flag, inline] = arg.split('=');
    const value = inline ?? argv[++index];
    if (flag === '--clients') {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 2000) {
        throw new UsageError(`--clients must be an integer between 1 and 2000, got ${JSON.stringify(value)}`);
      }
      clients = parsed;
    } else if (flag === '--ticks') {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 600) {
        throw new UsageError(`--ticks must be an integer between 1 and 600, got ${JSON.stringify(value)}`);
      }
      ticks = parsed;
    } else if (flag === '--games') {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 200) {
        throw new UsageError(`--games must be an integer between 0 and 200, got ${JSON.stringify(value)}`);
      }
      games = parsed;
    } else if (flag === '--out') {
      if (!value) throw new UsageError('--out requires a path');
      out = resolve(value);
    } else {
      throw new UsageError(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  return { clients, ticks, games, out };
}

/** Cgroup/limits that bound the measurement, when the file exists. */
function readCgroupValue(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8').trim() : null;
  } catch {
    return null;
  }
}

function kernelVersion(): string {
  try {
    return execFileSync('uname', ['-r'], { encoding: 'utf8' }).trim();
  } catch {
    return release();
  }
}

/**
 * Plays `games` matches on this host with the two repository bots and reports per-game wall time.
 * The orchestrator spawns real bot processes, so this is the closest local proxy for official game
 * execution — without the sandbox, cgroup limits or the release host.
 */
async function measureGameExecution(games: number): Promise<{
  readonly games: number;
  readonly meanMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly gamesPerSecond: number;
  readonly turnsPerGame: number;
}> {
  const descriptor = sampleMap as unknown as MapDescriptor;
  const times: number[] = [];
  const turns: number[] = [];
  for (let index = 0; index < games; index++) {
    const started = process.hrtime.bigint();
    const result = await new MatchOrchestrator({
      mapDescriptor: descriptor,
      whiteBotConfig: { path: resolve('bots/greedy-bot.ts') },
      blackBotConfig: { path: resolve('bots/random-bot.ts') },
      maxTurns: 120,
    }).runMatch();
    times.push(Number(process.hrtime.bigint() - started) / 1e6);
    turns.push(result.turns.length);
  }
  const totalMs = times.reduce((sum, value) => sum + value, 0);
  return {
    games,
    meanMs: Number((totalMs / games).toFixed(1)),
    minMs: Number(Math.min(...times).toFixed(1)),
    maxMs: Number(Math.max(...times).toFixed(1)),
    gamesPerSecond: Number((games / (totalMs / 1000)).toFixed(3)),
    turnsPerGame: Number((turns.reduce((sum, value) => sum + value, 0) / games).toFixed(1)),
  };
}

async function main(): Promise<void> {
  let options: Options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    console.error(
      'usage: npx tsx deploy/linux/capacity-probe.ts [--clients N] [--ticks N] [--out PATH]\n' +
        (error instanceof Error ? error.message : String(error))
    );
    process.exit(2);
  }

  const cores = cpus().length;
  const memoryTotalMb = Math.round(totalmem() / (1024 * 1024));
  const memoryFreeMb = Math.round(freemem() / (1024 * 1024));
  const loadBefore = loadavg();

  const metrics = await runWebSocketBenchmark({ clientCount: options.clients, ticksCount: options.ticks });
  const gameExecution = options.games > 0 ? await measureGameExecution(options.games) : null;
  const loadAfter = loadavg();

  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: 'DEV_HOST_MEASUREMENT_NOT_CERTIFIED',
    host: {
      platform: `${platform()} ${arch()}`,
      kernel: kernelVersion(),
      cpuCount: cores,
      loadAverageBefore: loadBefore,
      loadAverageAfter: loadAfter,
      memoryTotalMb,
      memoryFreeMbBeforeProbe: memoryFreeMb,
      cgroupMemoryMax: readCgroupValue('/sys/fs/cgroup/memory.max'),
      cgroupCpuMax: readCgroupValue('/sys/fs/cgroup/cpu.max'),
      node: process.version,
    },
    workload: {
      kind: 'SPECTATOR_WEBSOCKET_FANOUT',
      clients: metrics.totalClients,
      broadcastTicks: metrics.totalTicks,
      framesPerSecondPerClient: 60,
      iterations: 1,
      serverMode: 'in-process Fastify app (createApp), in-memory database',
    },
    metrics: {
      connectionRampUpMs: Number(metrics.connectionTimeMs.toFixed(1)),
      expectedDeliveries: metrics.expectedDeliveries,
      actualDeliveries: metrics.actualDeliveries,
      packetDropRatePercent: Number(metrics.packetDropRate.toFixed(3)),
      averageFrameBytes: Number(metrics.averageFrameBytes.toFixed(1)),
      p50Ms: Number(metrics.p50Ms.toFixed(2)),
      p95Ms: Number(metrics.p95Ms.toFixed(2)),
      p99Ms: Number(metrics.p99Ms.toFixed(2)),
      maxMs: Number(metrics.maxMs.toFixed(2)),
      broadcastDurationMs: Number(metrics.broadcastDurationMs.toFixed(1)),
      processRssBeforeMb: metrics.memoryRssBeforeMb,
      processRssAfterMb: metrics.memoryRssAfterMb,
      passedSla: metrics.passedSLA,
    },
    gameExecution: gameExecution
      ? {
          kind: 'GAME_EXECUTION',
          bots: 'bots/greedy-bot.ts (WHITE) vs bots/random-bot.ts (BLACK), map docs/specs/maps/sample-donut.map.json, maxTurns 120',
          ...gameExecution,
        }
      : null,
    notMeasured: [
      'official/builder game execution throughput (needs the sandboxed supervisor and SDks on the release target)',
      'storage/WAL growth under a 249,500-game round robin',
      'declared release host, its CPU quota, disk headroom and TLS overhead',
      'multi-hour stability, restart behaviour and 500-team/1,000-viewer mixed workload',
    ],
    note: 'Numbers describe this development host only; they do not certify release capacity or SLO compliance.',
  };

  const line = JSON.stringify(payload, null, 2);
  if (options.out) writeFileSync(options.out, `${line}\n`);
  process.stdout.write(`${line}\n`);
}

void main();
