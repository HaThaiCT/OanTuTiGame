#!/usr/bin/env node
/**
 * CLI Entrypoint to execute live OanTuTi matches head-to-head.
 * Usage:
 *   npx tsx packages/runner/bin/run-match.ts --map docs/specs/maps/sample-donut.map.json --white bots/greedy-bot.ts --black bots/random-bot.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  MapDescriptor,
  validateMapTopology,
  WinReason,
  PlayerSide,
  PieceType,
  parsePieceType,
  parsePlayerSide,
  playerSideToString,
} from '@oantuti/engine';
import {
  encodeValidTilesBitmask,
  packReplay,
  MatchInitFrameMessage,
  TurnDeltaFrameMessage,
  MatchEndFrameMessage,
} from '@oantuti/protocol';
import { MatchOrchestrator, TurnRecord } from '../src/orchestrator.js';

interface CliArgs {
  mapPath: string;
  whitePath: string;
  blackPath: string;
  maxTurns: number;
  replayPath?: string;
}

const WIN_REASON_NAMES: Record<number, string> = {
  [WinReason.WIN_REASON_UNSPECIFIED]: 'WIN_REASON_UNSPECIFIED',
  [WinReason.EXTINCTION]: 'EXTINCTION (Species Extinction Win)',
  [WinReason.THRONE_BREACH]: 'THRONE_BREACH (Enemy Throne Capture Win)',
  [WinReason.STALEMATE]: 'STALEMATE (Opponent Has 0 Legal Moves)',
  [WinReason.TIMEOUT]: 'TIMEOUT (Turn Exceeded Time Limit)',
  [WinReason.ILLEGAL_MOVE]: 'ILLEGAL_MOVE (Move Violates Game Invariants)',
  [WinReason.CRASH_FORFEIT]: 'CRASH_FORFEIT (Process Crashed / OOM)',
  [WinReason.MAX_TURNS_DRAW]: 'MAX_TURNS_DRAW (Reached Max Turn Threshold)',
  [WinReason.PROTOCOL_VIOLATION]: 'PROTOCOL_VIOLATION (Malformed NDJSON Protocol)',
};

function parseArgs(args: string[]): CliArgs {
  let mapPath = 'docs/specs/maps/sample-donut.map.json';
  let whitePath = 'bots/greedy-bot.ts';
  let blackPath = 'bots/random-bot.ts';
  let maxTurns = 300;
  let replayPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--map' && i + 1 < args.length) {
      mapPath = args[++i];
    } else if (arg === '--white' && i + 1 < args.length) {
      whitePath = args[++i];
    } else if (arg === '--black' && i + 1 < args.length) {
      blackPath = args[++i];
    } else if (arg === '--max-turns' && i + 1 < args.length) {
      maxTurns = parseInt(args[++i], 10) || 300;
    } else if (arg === '--replay' && i + 1 < args.length) {
      replayPath = args[++i];
    }
  }

  return { mapPath, whitePath, blackPath, maxTurns, replayPath };
}

async function main(): Promise<void> {
  const cliArgs = parseArgs(process.argv.slice(2));

  const resolvedMapPath = path.resolve(process.cwd(), cliArgs.mapPath);
  if (!fs.existsSync(resolvedMapPath)) {
    process.stderr.write(`Error: Map file not found at ${resolvedMapPath}\n`);
    process.exit(1);
  }

  const rawMap = fs.readFileSync(resolvedMapPath, 'utf-8');
  let mapDescriptor: MapDescriptor;
  try {
    mapDescriptor = JSON.parse(rawMap) as MapDescriptor;
  } catch (err) {
    process.stderr.write(`Error: Failed to parse map JSON: ${(err as Error).message}\n`);
    process.exit(1);
  }

  const validation = validateMapTopology(mapDescriptor);
  if (!validation.valid) {
    process.stderr.write(`Error: Invalid map descriptor:\n  - ${validation.errors.join('\n  - ')}\n`);
    process.exit(1);
  }

  process.stdout.write(`\n=======================================================\n`);
  process.stdout.write(`          OanTuTi Arena Match Runner (CLI)            \n`);
  process.stdout.write(`=======================================================\n`);
  process.stdout.write(`Map:   ${mapDescriptor.mapName} (${mapDescriptor.width}x${mapDescriptor.height})\n`);
  process.stdout.write(`White: ${cliArgs.whitePath}\n`);
  process.stdout.write(`Black: ${cliArgs.blackPath}\n`);
  process.stdout.write(`Budget: 100ms per turn | Max Turns: ${cliArgs.maxTurns}\n`);
  process.stdout.write(`-------------------------------------------------------\n\n`);

  const orchestrator = new MatchOrchestrator({
    matchId: `cli_match_${Date.now()}`,
    mapDescriptor,
    whiteBotConfig: { path: cliArgs.whitePath },
    blackBotConfig: { path: cliArgs.blackPath },
    maxTurns: cliArgs.maxTurns,
    onTurn: (record: TurnRecord) => {
      const playerStr = record.player === PlayerSide.WHITE ? 'WHITE' : 'BLACK';
      let actionStr = '';
      if (record.action.action === 'PASS') {
        actionStr = 'PASS';
      } else {
        actionStr = `Piece #${record.action.pieceId} -> (${record.action.target[0]}, ${record.action.target[1]})`;
      }

      let captureStr = '';
      if (record.capture) {
        captureStr = ` [CAPTURE! Victim #${record.capture.victimId}]`;
      }

      process.stdout.write(
        `Turn ${String(record.turnNumber).padStart(3, ' ')} | ${playerStr.padEnd(5, ' ')} | ${actionStr}${captureStr} (${record.durationMs.toFixed(1)}ms)\n`
      );
    },
  });

  const startTime = Date.now();
  const result = await orchestrator.runMatch();
  const elapsedMs = Date.now() - startTime;

  process.stdout.write(`\n-------------------------------------------------------\n`);
  process.stdout.write(`                     MATCH SUMMARY                     \n`);
  process.stdout.write(`-------------------------------------------------------\n`);
  const winnerStr =
    result.winner !== undefined
      ? `${playerSideToString(result.winner)} WINS`
      : 'DRAW';
  process.stdout.write(`Result:               ${winnerStr}\n`);
  process.stdout.write(`Reason:               ${WIN_REASON_NAMES[result.winReason] ?? result.winReason}\n`);
  process.stdout.write(`Total Turns:          ${result.totalTurns}\n`);
  process.stdout.write(`White Remaining:      ${result.whitePiecesRemaining}\n`);
  process.stdout.write(`Black Remaining:      ${result.blackPiecesRemaining}\n`);
  process.stdout.write(`Total Elapsed Time:   ${(elapsedMs / 1000).toFixed(2)}s\n`);
  process.stdout.write(`=======================================================\n\n`);

  if (cliArgs.replayPath) {
    const bitmask = encodeValidTilesBitmask(
      mapDescriptor.width,
      mapDescriptor.height,
      mapDescriptor.validTiles
    );

    const initFrame: MatchInitFrameMessage = {
      matchId: result.matchId,
      map: {
        width: mapDescriptor.width,
        height: mapDescriptor.height,
        validTilesBitmask: bitmask,
        whiteThrone: { x: mapDescriptor.whiteThrone[0], y: mapDescriptor.whiteThrone[1] },
        blackThrone: { x: mapDescriptor.blackThrone[0], y: mapDescriptor.blackThrone[1] },
        mapName: mapDescriptor.mapName,
      },
      pieces: mapDescriptor.startingPieces.map((p) => ({
        id: p.id,
        owner: parsePlayerSide(p.owner),
        type: parsePieceType(p.type),
        pos: { x: p.pos[0], y: p.pos[1] },
        isAlive: true,
      })),
      maxTurns: cliArgs.maxTurns,
      turnTimeLimitMs: 100,
      whiteBotName: path.basename(cliArgs.whitePath),
      blackBotName: path.basename(cliArgs.blackPath),
    };

    const deltaFrames: TurnDeltaFrameMessage[] = result.turns.map((t, idx) => ({
      turnNumber: t.turnNumber,
      activePlayer: t.player,
      action:
        t.action.action === 'MOVE'
          ? {
              pieceId: t.action.pieceId,
              targetPos: { x: t.action.target[0], y: t.action.target[1] },
            }
          : undefined,
      capture: t.capture
        ? {
            attackerId: t.capture.attackerId,
            victimId: t.capture.victimId,
            victimType: t.capture.victimType,
            pos: { x: t.capture.pos.x, y: t.capture.pos.y },
          }
        : undefined,
      timeConsumedNs: BigInt(Math.round(t.durationMs * 1_000_000)),
      isGameOver: idx === result.turns.length - 1,
      winner: idx === result.turns.length - 1 ? result.winner : undefined,
      winReason: idx === result.turns.length - 1 ? result.winReason : undefined,
    }));

    const endFrame: MatchEndFrameMessage = {
      matchId: result.matchId,
      winner: result.winner,
      reason: result.winReason,
      totalTurns: result.totalTurns,
      whiteRemainingPieces: result.whitePiecesRemaining,
      blackRemainingPieces: result.blackPiecesRemaining,
    };

    const replayBinary = packReplay(initFrame, deltaFrames, endFrame);
    const outReplayPath = path.resolve(process.cwd(), cliArgs.replayPath);
    fs.writeFileSync(outReplayPath, replayBinary);
    process.stdout.write(`Replay saved: ${outReplayPath} (${replayBinary.length} bytes)\n\n`);
  }

  if (result.whiteStderr.trim()) {
    process.stderr.write(`[WHITE STDERR]:\n${result.whiteStderr.trim()}\n\n`);
  }
  if (result.blackStderr.trim()) {
    process.stderr.write(`[BLACK STDERR]:\n${result.blackStderr.trim()}\n\n`);
  }

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`Fatal Error: ${(err as Error).stack || err}\n`);
  process.exit(1);
});
