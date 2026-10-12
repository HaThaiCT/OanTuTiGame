/**
 * STDIO NDJSON Bot Process Driver & Turn Budget Enforcer
 * High-precision timing via process.hrtime.bigint() and strict protocol validation.
 */

import { ChildProcess, spawn, SpawnOptions, execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { WinReason } from '@oantuti/engine';

export interface BotInitPayload {
  readonly type: 'INIT';
  readonly match_id: string;
  readonly my_side: 'WHITE' | 'BLACK';
  readonly map: {
    readonly name: string;
    readonly width: number;
    readonly height: number;
    readonly valid_tiles: readonly [number, number][];
    readonly white_throne: readonly [number, number];
    readonly black_throne: readonly [number, number];
  };
  readonly pieces: readonly Array<{
    readonly id: number;
    readonly owner: 'WHITE' | 'BLACK';
    readonly type: 'ROCK' | 'SCISSORS' | 'PAPER';
    readonly x: number;
    readonly y: number;
    readonly is_alive: boolean;
  }>;
  readonly turn_time_limit_ms: number;
  readonly max_turns: number;
}

export interface BotTurnPayload {
  readonly type: 'TURN';
  readonly turn_number: number;
  readonly time_remaining_ms: number;
  readonly pieces: readonly Array<{
    readonly id: number;
    readonly owner: 'WHITE' | 'BLACK';
    readonly type: 'ROCK' | 'SCISSORS' | 'PAPER';
    readonly x: number;
    readonly y: number;
    readonly is_alive: boolean;
  }>;
}

export interface MoveResponse {
  readonly action: 'MOVE' | 'PASS';
  readonly piece_id?: number;
  readonly target?: [number, number];
}

export class DisqualificationError extends Error {
  constructor(
    public readonly reason: WinReason,
    public readonly details: string
  ) {
    super(`Disqualified (${WinReason[reason] ?? reason}): ${details}`);
    this.name = 'DisqualificationError';
  }
}

export function resolveBotCommand(botPath: string): { command: string; args: string[] } {
  const resolvedPath = path.resolve(process.cwd(), botPath);

  if (resolvedPath.endsWith('.ts')) {
    const tsxDist = path.resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
    if (fs.existsSync(tsxDist)) {
      return { command: process.execPath, args: [tsxDist, resolvedPath] };
    }
    return { command: 'npx', args: ['tsx', resolvedPath] };
  }

  if (
    resolvedPath.endsWith('.js') ||
    resolvedPath.endsWith('.mjs') ||
    resolvedPath.endsWith('.cjs')
  ) {
    return { command: process.execPath, args: [resolvedPath] };
  }

  if (resolvedPath.endsWith('.py')) {
    return { command: 'python3', args: [resolvedPath] };
  }

  if (resolvedPath.endsWith('.cpp')) {
    const binPath = resolvedPath.replace(/\.cpp$/, '');
    const needsCompile =
      !fs.existsSync(binPath) ||
      fs.statSync(resolvedPath).mtimeMs > fs.statSync(binPath).mtimeMs;
    if (needsCompile) {
      execFileSync('g++', ['-std=c++20', '-O3', '-I', path.dirname(resolvedPath), resolvedPath, '-o', binPath]);
    }
    return { command: binPath, args: [] };
  }

  return { command: resolvedPath, args: [] };
}

export class BotProcess {
  private readonly child: ChildProcess;
  private lineBuffer: string = '';
  private readonly lineQueue: string[] = [];
  private pendingResolver: ((line: string) => void) | null = null;
  private pendingRejecter: ((err: Error) => void) | null = null;
  private stderrBuffer: string = '';
  private isExited: boolean = false;
  private exitCode: number | null = null;

  constructor(command: string, args: string[] = [], options?: SpawnOptions) {
    this.child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options,
    });

    this.child.stdout?.on('data', (chunk: Buffer) => {
      this.lineBuffer += chunk.toString('utf-8');
      let newlineIdx = this.lineBuffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = this.lineBuffer.slice(0, newlineIdx).trim();
        this.lineBuffer = this.lineBuffer.slice(newlineIdx + 1);

        if (line.length > 0) {
          if (this.pendingResolver) {
            const resolver = this.pendingResolver;
            this.pendingResolver = null;
            this.pendingRejecter = null;
            resolver(line);
          } else {
            this.lineQueue.push(line);
          }
        }
        newlineIdx = this.lineBuffer.indexOf('\n');
      }
    });

    this.child.stderr?.on('data', (chunk: Buffer) => {
      if (this.stderrBuffer.length < 65536) {
        this.stderrBuffer += chunk.toString('utf-8');
      }
    });

    this.child.on('error', (err: Error) => {
      this.isExited = true;
      if (this.pendingRejecter) {
        const rejecter = this.pendingRejecter;
        this.pendingResolver = null;
        this.pendingRejecter = null;
        rejecter(new DisqualificationError(WinReason.CRASH_FORFEIT, err.message));
      }
    });

    this.child.on('close', (code: number | null) => {
      this.isExited = true;
      this.exitCode = code;
      if (this.pendingRejecter) {
        const rejecter = this.pendingRejecter;
        this.pendingResolver = null;
        this.pendingRejecter = null;
        rejecter(
          new DisqualificationError(
            WinReason.CRASH_FORFEIT,
            `Process exited unexpectedly with code ${code}`
          )
        );
      }
    });
  }

  private readLine(timeoutMs: number): Promise<string> {
    if (this.lineQueue.length > 0) {
      return Promise.resolve(this.lineQueue.shift()!);
    }

    if (this.isExited) {
      return Promise.reject(
        new DisqualificationError(
          WinReason.CRASH_FORFEIT,
          `Process exited with code ${this.exitCode}`
        )
      );
    }

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRejecter === reject) {
          this.pendingResolver = null;
          this.pendingRejecter = null;
          this.kill();
          reject(
            new DisqualificationError(
              WinReason.TIMEOUT,
              `Execution time exceeded ${timeoutMs}ms timeout limit`
            )
          );
        }
      }, timeoutMs);

      this.pendingResolver = (line: string) => {
        clearTimeout(timer);
        resolve(line);
      };

      this.pendingRejecter = (err: Error) => {
        clearTimeout(timer);
        reject(err);
      };
    });
  }

  async sendInit(
    payload: BotInitPayload,
    timeoutMs: number = 1000
  ): Promise<{ timeConsumedMs: number }> {
    if (this.isExited) {
      throw new DisqualificationError(
        WinReason.CRASH_FORFEIT,
        `Process already terminated with code ${this.exitCode}`
      );
    }

    const startNs = process.hrtime.bigint();
    const jsonStr = JSON.stringify(payload) + '\n';
    this.child.stdin?.write(jsonStr);

    // 1000ms budget + 20ms grace period for I/O pipe
    const rawLine = await this.readLine(timeoutMs + 20);
    const elapsedNs = process.hrtime.bigint() - startNs;
    const timeConsumedMs = Number(elapsedNs) / 1_000_000;

    let response: unknown;
    try {
      response = JSON.parse(rawLine);
    } catch {
      this.kill();
      throw new DisqualificationError(
        WinReason.PROTOCOL_VIOLATION,
        `Invalid JSON syntax on INIT response: ${rawLine}`
      );
    }

    if (
      !response ||
      typeof response !== 'object' ||
      (response as Record<string, unknown>).status !== 'READY'
    ) {
      this.kill();
      throw new DisqualificationError(
        WinReason.PROTOCOL_VIOLATION,
        `Expected status "READY" on INIT response, received: ${rawLine}`
      );
    }

    return { timeConsumedMs };
  }

  async sendTurn(
    payload: BotTurnPayload,
    timeoutMs: number = 100
  ): Promise<{ action: MoveResponse; timeConsumedMs: number }> {
    if (this.isExited) {
      throw new DisqualificationError(
        WinReason.CRASH_FORFEIT,
        `Process already terminated with code ${this.exitCode}`
      );
    }

    const startNs = process.hrtime.bigint();
    const jsonStr = JSON.stringify(payload) + '\n';
    this.child.stdin?.write(jsonStr);

    // 100ms budget + 5ms grace period for stream buffer
    const rawLine = await this.readLine(timeoutMs + 5);
    const elapsedNs = process.hrtime.bigint() - startNs;
    const timeConsumedMs = Number(elapsedNs) / 1_000_000;

    const budgetLimitNs = BigInt((timeoutMs + 5) * 1_000_000);
    if (elapsedNs > budgetLimitNs) {
      this.kill();
      throw new DisqualificationError(
        WinReason.TIMEOUT,
        `Turn time ${timeConsumedMs.toFixed(2)}ms exceeded ${timeoutMs}ms limit`
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      this.kill();
      throw new DisqualificationError(
        WinReason.PROTOCOL_VIOLATION,
        `Invalid JSON syntax on TURN response: ${rawLine}`
      );
    }

    if (!parsed || typeof parsed !== 'object') {
      this.kill();
      throw new DisqualificationError(
        WinReason.PROTOCOL_VIOLATION,
        `TURN response must be a JSON object, received: ${rawLine}`
      );
    }

    const obj = parsed as Record<string, unknown>;
    const action = obj.action;

    if (action === 'PASS') {
      return { action: { action: 'PASS' }, timeConsumedMs };
    }

    if (action === 'MOVE') {
      const pieceId = obj.piece_id;
      const target = obj.target;

      if (
        typeof pieceId !== 'number' ||
        !Array.isArray(target) ||
        target.length !== 2 ||
        typeof target[0] !== 'number' ||
        typeof target[1] !== 'number'
      ) {
        this.kill();
        throw new DisqualificationError(
          WinReason.PROTOCOL_VIOLATION,
          `MOVE action requires numeric piece_id and target [x, y], got: ${rawLine}`
        );
      }

      return {
        action: {
          action: 'MOVE',
          piece_id: pieceId,
          target: [target[0], target[1]],
        },
        timeConsumedMs,
      };
    }

    this.kill();
    throw new DisqualificationError(
      WinReason.PROTOCOL_VIOLATION,
      `Unknown action "${action}" in TURN response: ${rawLine}`
    );
  }

  getStderr(): string {
    return this.stderrBuffer;
  }

  isProcessAlive(): boolean {
    return !this.isExited;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.isExited) return;
    try {
      this.child.kill(signal);
    } catch {
      // Ignore if process already died
    }

    setTimeout(() => {
      if (!this.isExited) {
        try {
          this.child.kill('SIGKILL');
        } catch {
          // Ignore
        }
      }
    }, 50);
  }
}
