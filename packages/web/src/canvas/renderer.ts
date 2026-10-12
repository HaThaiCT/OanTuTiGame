/**
 * 6-Layer Canvas 2D Rendering Pipeline for OanTuTi Arena
 * Adheres strictly to docs/specs/06-UI-UX-VISUALIZER-SPEC.md Section 3.
 */

import { PieceType, PlayerSide, Coord } from '@oantuti/engine';
import { ViewportTransform, boardToScreen, boardToScreenCenter } from './viewport.js';

export interface RenderPiece {
  readonly id: number;
  readonly owner: PlayerSide;
  readonly type: PieceType;
  readonly x: number;
  readonly y: number;
  readonly isAlive: boolean;
  // Animation props
  readonly animStartX?: number;
  readonly animStartY?: number;
  readonly animProgress?: number; // 0..1
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  radius: number;
  alpha: number;
  life: number;
  maxLife: number;
}

export interface RenderState {
  readonly width: number;
  readonly height: number;
  readonly validTiles: ReadonlySet<string>;
  readonly whiteThrone: Coord;
  readonly blackThrone: Coord;
  readonly pieces: readonly RenderPiece[];
  readonly lastMove?: {
    readonly pieceId: number;
    readonly from: Coord;
    readonly to: Coord;
    readonly isCapture?: boolean;
  };
  readonly selectedPieceId?: number;
  readonly legalMoveTargets?: readonly Coord[];
  readonly hoveredCoord?: Coord;
  readonly animTimeMs: number;
  readonly particles: Particle[];
}

export function createCaptureParticles(
  centerScreenX: number,
  centerScreenY: number,
  color: string = '#f43f5e'
): Particle[] {
  const particles: Particle[] = [];
  const count = 16;

  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.3;
    const speed = 2 + Math.random() * 4;
    particles.push({
      x: centerScreenX,
      y: centerScreenY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      color,
      radius: 2 + Math.random() * 3,
      alpha: 1,
      life: 0,
      maxLife: 30, // ~500ms at 60fps
    });
  }

  return particles;
}

export function updateParticles(particles: Particle[]): void {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.vx *= 0.94;
    p.vy *= 0.94;
    p.life++;
    p.alpha = Math.max(0, 1 - p.life / p.maxLife);

    if (p.life >= p.maxLife) {
      particles.splice(i, 1);
    }
  }
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

/**
 * Executes full 6-layer render frame on Canvas 2D context.
 */
export function renderCanvasFrame(
  ctx: CanvasRenderingContext2D,
  transform: ViewportTransform,
  state: RenderState
): void {
  const { canvasWidth, canvasHeight, tileSize } = transform;

  // Clear full canvas
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // ==========================================
  // Layer 1: Background & Void Layer
  // ==========================================
  for (let y = 0; y < state.height; y++) {
    for (let x = 0; x < state.width; x++) {
      if (!state.validTiles.has(`${x},${y}`)) {
        const pt = boardToScreen(x, y, transform);
        // Draw void pattern (subtle dotted matrix)
        ctx.fillStyle = '#090d16';
        ctx.fillRect(pt.x + 2, pt.y + 2, tileSize - 4, tileSize - 4);

        ctx.fillStyle = '#1e293b';
        const center = boardToScreenCenter(x, y, transform);
        ctx.beginPath();
        ctx.arc(center.x, center.y, Math.max(1.5, tileSize * 0.04), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // ==========================================
  // Layer 2: Valid Tiles Grid Layer
  // ==========================================
  const cornerRadius = Math.max(2, Math.min(8, tileSize * 0.1));

  for (let y = 0; y < state.height; y++) {
    for (let x = 0; x < state.width; x++) {
      if (state.validTiles.has(`${x},${y}`)) {
        const pt = boardToScreen(x, y, transform);
        const isCheckerLight = (x + y) % 2 === 0;
        ctx.fillStyle = isCheckerLight ? '#1e293b' : '#141d2d';

        ctx.beginPath();
        ctx.roundRect(pt.x + 2, pt.y + 2, tileSize - 4, tileSize - 4, cornerRadius);
        ctx.fill();

        ctx.strokeStyle = '#334155';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  // ==========================================
  // Layer 3: Throne Objective Indicators
  // ==========================================
  const pulseFactor = 0.5 + 0.5 * Math.sin(state.animTimeMs * 0.005);

  // White Throne (TW) - Gold Pulse
  if (state.validTiles.has(`${state.whiteThrone.x},${state.whiteThrone.y}`)) {
    const pt = boardToScreen(state.whiteThrone.x, state.whiteThrone.y, transform);
    ctx.strokeStyle = `rgba(234, 179, 8, ${0.4 + 0.4 * pulseFactor})`;
    ctx.lineWidth = Math.max(2, tileSize * 0.06);
    ctx.beginPath();
    ctx.roundRect(pt.x + 4, pt.y + 4, tileSize - 8, tileSize - 8, cornerRadius);
    ctx.stroke();

    const center = boardToScreenCenter(state.whiteThrone.x, state.whiteThrone.y, transform);
    ctx.fillStyle = 'rgba(234, 179, 8, 0.2)';
    ctx.beginPath();
    ctx.arc(center.x, center.y, tileSize * 0.35, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#eab308';
    ctx.font = `bold ${Math.max(10, Math.round(tileSize * 0.22))}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('TW', center.x, center.y);
  }

  // Black Throne (TB) - Purple Pulse
  if (state.validTiles.has(`${state.blackThrone.x},${state.blackThrone.y}`)) {
    const pt = boardToScreen(state.blackThrone.x, state.blackThrone.y, transform);
    ctx.strokeStyle = `rgba(168, 85, 247, ${0.4 + 0.4 * pulseFactor})`;
    ctx.lineWidth = Math.max(2, tileSize * 0.06);
    ctx.beginPath();
    ctx.roundRect(pt.x + 4, pt.y + 4, tileSize - 8, tileSize - 8, cornerRadius);
    ctx.stroke();

    const center = boardToScreenCenter(state.blackThrone.x, state.blackThrone.y, transform);
    ctx.fillStyle = 'rgba(168, 85, 247, 0.2)';
    ctx.beginPath();
    ctx.arc(center.x, center.y, tileSize * 0.35, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#c084fc';
    ctx.font = `bold ${Math.max(10, Math.round(tileSize * 0.22))}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('TB', center.x, center.y);
  }

  // ==========================================
  // Layer 4: Overlays, Last Move & Highlights
  // ==========================================
  // Last move trail
  if (state.lastMove) {
    const fromCenter = boardToScreenCenter(state.lastMove.from.x, state.lastMove.from.y, transform);
    const toCenter = boardToScreenCenter(state.lastMove.to.x, state.lastMove.to.y, transform);

    ctx.strokeStyle = 'rgba(56, 189, 248, 0.5)';
    ctx.lineWidth = Math.max(2, tileSize * 0.05);
    ctx.setLineDash([tileSize * 0.1, tileSize * 0.08]);
    ctx.beginPath();
    ctx.moveTo(fromCenter.x, fromCenter.y);
    ctx.lineTo(toCenter.x, toCenter.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Legal move targets for selected piece
  if (state.legalMoveTargets && state.legalMoveTargets.length > 0) {
    for (const target of state.legalMoveTargets) {
      const center = boardToScreenCenter(target.x, target.y, transform);
      ctx.fillStyle = 'rgba(34, 197, 94, 0.35)';
      ctx.beginPath();
      ctx.arc(center.x, center.y, tileSize * 0.2, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = '#22c55e';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  // Hover indicator
  if (state.hoveredCoord && state.validTiles.has(`${state.hoveredCoord.x},${state.hoveredCoord.y}`)) {
    const pt = boardToScreen(state.hoveredCoord.x, state.hoveredCoord.y, transform);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(pt.x + 3, pt.y + 3, tileSize - 6, tileSize - 6, cornerRadius);
    ctx.stroke();
  }

  // ==========================================
  // Layer 5: Pieces Layer & Lerp Animation
  // ==========================================
  const livingPieces = state.pieces.filter((p) => p.isAlive);

  for (const p of livingPieces) {
    let screenX: number;
    let screenY: number;

    if (
      p.animStartX !== undefined &&
      p.animStartY !== undefined &&
      p.animProgress !== undefined &&
      p.animProgress < 1
    ) {
      const ease = easeInOutQuad(p.animProgress);
      const startPt = boardToScreenCenter(p.animStartX, p.animStartY, transform);
      const endPt = boardToScreenCenter(p.x, p.y, transform);
      screenX = (1 - ease) * startPt.x + ease * endPt.x;
      screenY = (1 - ease) * startPt.y + ease * endPt.y;
    } else {
      const pt = boardToScreenCenter(p.x, p.y, transform);
      screenX = pt.x;
      screenY = pt.y;
    }

    const radius = tileSize * 0.34;
    const isWhite = p.owner === PlayerSide.WHITE;

    // Outer glow / selection ring
    if (state.selectedPieceId === p.id) {
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = Math.max(3, tileSize * 0.08);
      ctx.beginPath();
      ctx.arc(screenX, screenY, radius + 4, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Piece Body
    ctx.fillStyle = isWhite ? '#38bdf8' : '#f43f5e';
    ctx.beginPath();
    ctx.arc(screenX, screenY, radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = isWhite ? '#f8fafc' : '#020617';
    ctx.lineWidth = Math.max(2, tileSize * 0.06);
    ctx.stroke();

    // Emblem Icon / Text
    let label = 'R';
    if (p.type === PieceType.SCISSORS) label = 'S';
    else if (p.type === PieceType.PAPER) label = 'P';

    ctx.fillStyle = isWhite ? '#0f172a' : '#ffffff';
    ctx.font = `800 ${Math.max(12, Math.round(tileSize * 0.32))}px 'JetBrains Mono', monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, screenX, screenY);
  }

  // ==========================================
  // Layer 6: Capture Particles & Explosions
  // ==========================================
  for (const part of state.particles) {
    ctx.fillStyle = part.color;
    ctx.globalAlpha = part.alpha;
    ctx.beginPath();
    ctx.arc(part.x, part.y, part.radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1.0;
}
