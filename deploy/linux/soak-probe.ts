#!/usr/bin/env npx tsx
/**
 * Bounded development soak (S17 partial evidence).
 *
 * Runs a short, repeatable endurance loop against the **running development API** and samples the
 * server's own resources while it does: public reads, binary replay fetches and spectator WebSocket
 * connect/close churn. The point is to catch unbounded growth (RSS, file descriptors, DB rows) over
 * time — not to certify the 72 h soak or the 7-day rehearsal, which need the release host and the
 * sandboxed execution path.
 *
 * Usage:
 *   npx tsx deploy/linux/soak-probe.ts [--minutes N] [--clients N] [--api URL] [--out PATH]
 *
 * Exit code: 0 when the loop ran (leaks, if any, are reported in the payload), 2 on usage error.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { WebSocket } from 'ws';

interface Options {
  readonly minutes: number;
  readonly clients: number;
  readonly api: string;
  readonly out: string | null;
}

class UsageError extends Error {}

function parseOptions(argv: readonly string[]): Options {
  let minutes = 5;
  let clients = 25;
  let api = 'http://127.0.0.1:4301';
  let out: string | null = null;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const [flag, inline] = arg.split('=');
    const value = inline ?? argv[++index];
    if (flag === '--minutes') {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 240) {
        throw new UsageError(`--minutes must be a number between 0 and 240, got ${JSON.stringify(value)}`);
      }
      minutes = parsed;
    } else if (flag === '--clients') {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
        throw new UsageError(`--clients must be an integer between 1 and 200, got ${JSON.stringify(value)}`);
      }
      clients = parsed;
    } else if (flag === '--api') {
      if (!value) throw new UsageError('--api requires a URL');
      api = value.replace(/\/$/, '');
    } else if (flag === '--out') {
      if (!value) throw new UsageError('--out requires a path');
      out = resolve(value);
    } else {
      throw new UsageError(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  return { minutes, clients, api, out };
}

/** Finds the API process the probe is hammering, so its RSS/FD can be sampled. */
function findServerPid(port: string): number | null {
  const entries = readdirSync('/proc').filter((entry) => /^\d+$/.test(entry));
  for (const entry of entries) {
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf8');
      if (!cmdline.includes('packages/server/src/index.ts')) continue;
      const environ = readFileSync(`/proc/${entry}/environ`, 'utf8');
      if (!environ.split('\0').includes(`PORT=${port}`)) continue;
      return Number(entry);
    } catch {
      continue;
    }
  }
  return null;
}

function readProc(pid: number | null): { rssMb: number | null; fds: number | null } {
  if (pid === null) return { rssMb: null, fds: null };
  let rssMb: number | null = null;
  let fds: number | null = null;
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = /VmRSS:\s+(\d+)\s+kB/.exec(status);
    if (match) rssMb = Math.round((Number(match[1]) / 1024) * 10) / 10;
  } catch {
    /* process may have restarted */
  }
  try {
    fds = readdirSync(`/proc/${pid}/fd`).length;
  } catch {
    /* ignore */
  }
  return { rssMb, fds };
}

async function timedFetch(url: string): Promise<{ ok: boolean; status: number; bytes: number; ms: number }> {
  const started = performance.now();
  try {
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    return { ok: response.ok, status: response.status, bytes: buffer.byteLength, ms: performance.now() - started };
  } catch {
    return { ok: false, status: 0, bytes: 0, ms: performance.now() - started };
  }
}

function wsCycle(url: string, timeoutMs = 4000): Promise<{ opened: boolean; closed: boolean; ms: number }> {
  const { promise, resolve } = Promise.withResolvers<{ opened: boolean; closed: boolean; ms: number }>();
  const started = performance.now();
  let opened = false;
  let closed = false;
  const socket = new WebSocket(url);
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({ opened, closed, ms: performance.now() - started });
  };
  const timer = setTimeout(() => {
    try {
      socket.terminate();
    } catch {
      /* ignore */
    }
    finish();
  }, timeoutMs);
  socket.on('open', () => {
    opened = true;
    socket.close();
  });
  socket.on('close', () => {
    closed = true;
    finish();
  });
  socket.on('error', () => finish());
  return promise;
}

async function main(): Promise<void> {
  let options: Options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    console.error(
      'usage: npx tsx deploy/linux/soak-probe.ts [--minutes N] [--clients N] [--api URL] [--out PATH]\n' +
        (error instanceof Error ? error.message : String(error))
    );
    process.exit(2);
  }

  const port = new URL(options.api).port || '80';
  const pid = findServerPid(port);
  const before = readProc(pid);

  const tournamentsResponse = await fetch(`${options.api}/api/v2/tournaments`);
  const tournamentsPayload = (await tournamentsResponse.json()) as { tournaments?: { id?: string; state?: string }[] };
  const tournaments = (tournamentsPayload.tournaments ?? []).filter((row): row is { id: string } => typeof row.id === 'string');
  if (tournaments.length === 0) {
    throw new UsageError('no tournaments on this API: start one before soaking');
  }

  let requests = 0;
  let failures = 0;
  let bytes = 0;
  let wsOpened = 0;
  let wsClosed = 0;
  const samples: { at: string; rssMb: number | null; fds: number | null }[] = [];
  const latencies: number[] = [];
  const deadline = Date.now() + options.minutes * 60_000;
  let round = 0;

  while (Date.now() < deadline) {
    round++;
    const tournament = tournaments[round % tournaments.length];
    for (const path of [
      '/api/v2/tournaments',
      `/api/v2/tournaments/${tournament.id}/bracket`,
      `/api/v2/tournaments/${tournament.id}/standings`,
      `/api/v2/tournaments/${tournament.id}/announcements`,
    ]) {
      const result = await timedFetch(`${options.api}${path}`);
      requests++;
      bytes += result.bytes;
      latencies.push(result.ms);
      if (!result.ok) failures++;
    }

    const cycles = await Promise.all(
      Array.from({ length: options.clients }, (_, index) =>
        wsCycle(`ws://127.0.0.1:${port}/ws/matches/soak_${round}_${index}`)
      )
    );
    for (const cycle of cycles) {
      if (cycle.opened) wsOpened++;
      if (cycle.closed) wsClosed++;
    }

    const sample = { at: new Date().toISOString(), ...readProc(pid) };
    samples.push(sample);
    const { promise: pause, resolve: resume } = Promise.withResolvers<void>();
    setTimeout(resume, 2000);
    await pause;
  }

  const after = readProc(pid);
  const rssValues = samples.map((sample) => sample.rssMb).filter((value): value is number => value !== null);
  const fdValues = samples.map((sample) => sample.fds).filter((value): value is number => value !== null);
  latencies.sort((a, b) => a - b);
  const percentile = (fraction: number): number =>
    latencies.length === 0 ? 0 : Number(latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * fraction))].toFixed(1));

  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: 'DEV_BOUNDED_SOAK_NOT_72H',
    api: options.api,
    serverPid: pid,
    workload: {
      kind: 'PUBLIC_READS_PLUS_WS_CHURN',
      minutes: options.minutes,
      rounds: round,
      httpRequests: requests,
      httpFailures: failures,
      bytesRead: bytes,
      wsClientsPerRound: options.clients,
      wsOpened,
      wsClosed,
      pollIntervalMs: 2000,
    },
    latencyMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
    resources: {
      rssMbBefore: before.rssMb,
      rssMbAfter: after.rssMb,
      rssMbMin: rssValues.length ? Math.min(...rssValues) : null,
      rssMbMax: rssValues.length ? Math.max(...rssValues) : null,
      rssMbGrowth: before.rssMb !== null && after.rssMb !== null ? Number((after.rssMb - before.rssMb).toFixed(1)) : null,
      fdsBefore: before.fds,
      fdsAfter: after.fds,
      fdsMin: fdValues.length ? Math.min(...fdValues) : null,
      fdsMax: fdValues.length ? Math.max(...fdValues) : null,
      samples: samples.length,
    },
    criteria: {
      httpFailuresZero: failures === 0,
      wsSocketsAllClosed: wsOpened === wsClosed,
      fdGrowthBounded: before.fds === null || after.fds === null ? null : after.fds - before.fds <= 16,
      rssGrowthBounded:
        before.rssMb === null || after.rssMb === null
          ? null
          : after.rssMb - before.rssMb <= Math.max(64, before.rssMb * 0.3),
    },
    notMeasured: [
      'official game execution, private TEST, build queue and job churn (needs submissions and the sandboxed executor)',
      'backup/restore rotation during the soak',
      'the 72-hour duration and the 7-day rehearsal required by S17',
      'the declared GA 6.8 release host, its CPU quota and disk pressure',
      'memory/FD behaviour while the real Bot processes run under cgroup limits',
    ],
    note: 'Bounded development soak only; it is not the S17 endurance gate.',
  };

  const line = JSON.stringify(payload, null, 2);
  if (options.out) writeFileSync(options.out, `${line}\n`);
  process.stdout.write(`${line}\n`);
}

void main();
