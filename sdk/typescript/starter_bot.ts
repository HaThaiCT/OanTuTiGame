#!/usr/bin/env node
/**
 * Starter Bot in TypeScript using OanTuTi SDK
 * Strategy:
 * 1. Immediate Throne Breach if adjacent to enemy throne
 * 2. Dominant Capture if enemy in reach
 * 3. Move advancing towards enemy throne
 * 4. Fallback to any legal move
 */

import { runBot, BotHandler, InitContext, TurnContext, BotAction, chebyshevDistance } from './oantuti.js';

class StarterBot implements BotHandler {
  private enemyThrone: readonly [number, number] = [0, 0];

  onInit(ctx: InitContext): void {
    this.enemyThrone = ctx.enemyThrone;
  }

  onTurn(ctx: TurnContext): BotAction {
    const legalMoves = ctx.getLegalMoves();
    if (legalMoves.length === 0) {
      return { action: 'PASS' };
    }

    const grid = new Map<string, (typeof ctx.pieces)[0]>();
    for (const p of ctx.pieces) {
      if (p.is_alive) {
        grid.set(`${p.x},${p.y}`, p);
      }
    }

    let bestMove = legalMoves[0];
    let bestScore = -999999;

    for (const move of legalMoves) {
      const [tx, ty] = move.target;
      const mover = ctx.myPieces.find((p) => p.id === move.piece_id);
      if (!mover) continue;

      let score = 0;

      // 1. Immediate Throne Breach
      if (tx === this.enemyThrone[0] && ty === this.enemyThrone[1]) {
        score += 100000;
      }

      // 2. Capture
      const occupant = grid.get(`${tx},${ty}`);
      if (occupant && occupant.owner !== ctx.mySide) {
        score += 5000;
      }

      // 3. Distance Delta towards enemy throne
      const curDist = chebyshevDistance(mover.x, mover.y, this.enemyThrone[0], this.enemyThrone[1]);
      const newDist = chebyshevDistance(tx, ty, this.enemyThrone[0], this.enemyThrone[1]);
      const distDelta = curDist - newDist;
      score += distDelta * 100 - newDist;

      if (score > bestScore) {
        bestScore = score;
        bestMove = move;
      }
    }

    return bestMove;
  }
}

runBot(new StarterBot());
