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

/**
 * Draws a stylized Hammer icon (Búa)
 */
function drawHammerIcon(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  color: string
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-0.35); // 20-degree dynamic battle angle

  ctx.fillStyle = color;
  ctx.strokeStyle = color;

  const headW = size * 0.72;
  const headH = size * 0.32;
  const handleW = size * 0.16;
  const handleH = size * 0.65;
  const headY = -size * 0.42;

  // Handle with rounded pommel
  ctx.beginPath();
  ctx.roundRect(-handleW / 2, headY + headH * 0.6, handleW, handleH, handleW / 3);
  ctx.fill();

  // Hammer Head (chamfered polygon)
  const chamfer = headH * 0.22;
  const left = -headW / 2;
  const right = headW / 2;
  const top = headY;
  const bottom = headY + headH;

  ctx.beginPath();
  ctx.moveTo(left + chamfer, top);
  ctx.lineTo(right - chamfer, top);
  ctx.lineTo(right, top + chamfer);
  ctx.lineTo(right, bottom - chamfer);
  ctx.lineTo(right - chamfer, bottom);
  ctx.lineTo(left + chamfer, bottom);
  ctx.lineTo(left, bottom - chamfer);
  ctx.lineTo(left, top + chamfer);
  ctx.closePath();
  ctx.fill();

  // Inner structural groove lines on hammer head
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
  ctx.lineWidth = Math.max(1, size * 0.04);
  ctx.beginPath();
  ctx.moveTo(left + headW * 0.24, top + 2);
  ctx.lineTo(left + headW * 0.24, bottom - 2);
  ctx.moveTo(right - headW * 0.24, top + 2);
  ctx.lineTo(right - headW * 0.24, bottom - 2);
  ctx.stroke();

  ctx.restore();
}

/**
 * Draws a stylized Scissors icon (Kéo)
 */
function drawScissorsIcon(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  color: string
): void {
  ctx.save();
  ctx.translate(cx, cy);

  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  const strokeW = Math.max(1.8, size * 0.08);
  ctx.lineWidth = strokeW;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const bladeLen = size * 0.46;
  const bladeAngle = 0.42;

  // Blade 1 (pointing up-left)
  ctx.save();
  ctx.rotate(-bladeAngle);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-size * 0.06, -bladeLen * 0.4);
  ctx.lineTo(0, -bladeLen);
  ctx.lineTo(size * 0.06, -bladeLen * 0.4);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Blade 2 (pointing up-right)
  ctx.save();
  ctx.rotate(bladeAngle);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-size * 0.06, -bladeLen * 0.4);
  ctx.lineTo(0, -bladeLen);
  ctx.lineTo(size * 0.06, -bladeLen * 0.4);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Left handle and loop
  const loopRadius = size * 0.15;
  const loopDistX = size * 0.24;
  const loopDistY = size * 0.30;

  ctx.beginPath();
  ctx.moveTo(-size * 0.06, 0);
  ctx.lineTo(-loopDistX, loopDistY - loopRadius);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(-loopDistX, loopDistY, loopRadius, 0, Math.PI * 2);
  ctx.stroke();

  // Right handle and loop
  ctx.beginPath();
  ctx.moveTo(size * 0.06, 0);
  ctx.lineTo(loopDistX, loopDistY - loopRadius);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(loopDistX, loopDistY, loopRadius, 0, Math.PI * 2);
  ctx.stroke();

  // Center pivot screw
  ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
  ctx.beginPath();
  ctx.arc(0, 0, strokeW * 0.8, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

/**
 * Draws a stylized Paper sheet icon (Bao)
 */
function drawPaperIcon(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  color: string
): void {
  ctx.save();
  ctx.translate(cx, cy);

  ctx.fillStyle = color;
  ctx.strokeStyle = color;

  const w = size * 0.62;
  const h = size * 0.78;
  const left = -w / 2;
  const right = w / 2;
  const top = -h / 2;
  const bottom = h / 2;
  const fold = size * 0.22;
  const r = Math.max(2, size * 0.05);

  // Main sheet with dog-ear notch
  ctx.beginPath();
  ctx.moveTo(left + r, top);
  ctx.lineTo(right - fold, top);
  ctx.lineTo(right, top + fold);
  ctx.lineTo(right, bottom - r);
  ctx.arcTo(right, bottom, right - r, bottom, r);
  ctx.lineTo(left + r, bottom);
  ctx.arcTo(left, bottom, left, bottom - r, r);
  ctx.lineTo(left, top + r);
  ctx.arcTo(left, top, left + r, top, r);
  ctx.closePath();
  ctx.fill();

  // 3D Fold flap triangle
  ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
  ctx.beginPath();
  ctx.moveTo(right - fold, top);
  ctx.lineTo(right - fold, top + fold);
  ctx.lineTo(right, top + fold);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)';
  ctx.lineWidth = Math.max(1, size * 0.035);
  ctx.stroke();

  // Document lines inside sheet
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.lineWidth = Math.max(1.5, size * 0.045);
  ctx.lineCap = 'round';

  const linePad = size * 0.12;
  const lineLeft = left + linePad;
  const lineRight = right - linePad;

  ctx.beginPath();
  ctx.moveTo(lineLeft, top + h * 0.42);
  ctx.lineTo(lineRight, top + h * 0.42);

  ctx.moveTo(lineLeft, top + h * 0.60);
  ctx.lineTo(lineRight, top + h * 0.60);

  ctx.moveTo(lineLeft, top + h * 0.78);
  ctx.lineTo(lineRight - size * 0.1, top + h * 0.78);
  ctx.stroke();

  ctx.restore();
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
      const t = p.animProgress;
      const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
      const startPt = boardToScreenCenter(p.animStartX, p.animStartY, transform);
      const endPt = boardToScreenCenter(p.x, p.y, transform);
      screenX = (1 - ease) * startPt.x + ease * endPt.x;
      screenY = (1 - ease) * startPt.y + ease * endPt.y;
    } else {
      const pt = boardToScreenCenter(p.x, p.y, transform);
      screenX = pt.x;
      screenY = pt.y;
    }

    const radius = tileSize * 0.35;
    const isWhite = p.owner === PlayerSide.WHITE;

    // Selection glow ring
    if (state.selectedPieceId === p.id) {
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = Math.max(3, tileSize * 0.08);
      ctx.beginPath();
      ctx.arc(screenX, screenY, radius + 4, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Piece Token Body with 3D Radial Gradient
    const grad = ctx.createRadialGradient(
      screenX - radius * 0.35,
      screenY - radius * 0.35,
      radius * 0.1,
      screenX,
      screenY,
      radius
    );
    if (isWhite) {
      grad.addColorStop(0, '#7dd3fc');
      grad.addColorStop(1, '#0284c7');
    } else {
      grad.addColorStop(0, '#fb7185');
      grad.addColorStop(1, '#be123c');
    }
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(screenX, screenY, radius, 0, Math.PI * 2);
    ctx.fill();

    // Inner token rim highlight
    ctx.strokeStyle = isWhite ? 'rgba(255, 255, 255, 0.45)' : 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = Math.max(1, tileSize * 0.025);
    ctx.beginPath();
    ctx.arc(screenX, screenY, radius - 2, 0, Math.PI * 2);
    ctx.stroke();

    // Token Outer Rim Border
    ctx.strokeStyle = isWhite ? '#f8fafc' : '#0f172a';
    ctx.lineWidth = Math.max(2, tileSize * 0.06);
    ctx.beginPath();
    ctx.arc(screenX, screenY, radius, 0, Math.PI * 2);
    ctx.stroke();

    // Draw Vector Image Icon (Búa / Kéo / Bao)
    const iconSize = radius * 1.15;
    const iconColor = '#f8fafc';

    if (p.type === PieceType.ROCK) {
      drawHammerIcon(ctx, screenX, screenY, iconSize, iconColor);
    } else if (p.type === PieceType.SCISSORS) {
      drawScissorsIcon(ctx, screenX, screenY, iconSize, iconColor);
    } else if (p.type === PieceType.PAPER) {
      drawPaperIcon(ctx, screenX, screenY, iconSize, iconColor);
    }
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
