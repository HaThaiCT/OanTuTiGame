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

export interface FloatingCombatText {
  text: string;
  x: number;
  y: number;
  color: string;
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
  readonly floatingTexts?: readonly FloatingCombatText[];
  readonly screenShakeOffset?: { readonly x: number; readonly y: number };
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

export function createFloatingText(
  list: FloatingCombatText[],
  text: string,
  screenX: number,
  screenY: number,
  color: string = '#f43f5e'
): void {
  list.push({
    text,
    x: screenX,
    y: screenY,
    color,
    alpha: 1,
    life: 0,
    maxLife: 45, // ~750ms at 60fps
  });
}

export function updateFloatingTexts(list: FloatingCombatText[]): void {
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i];
    item.y -= 1.2;
    item.life++;
    item.alpha = Math.max(0, 1 - item.life / item.maxLife);
    if (item.life >= item.maxLife) {
      list.splice(i, 1);
    }
  }
}

export function calculateScreenShakeOffset(
  currentTimeMs: number,
  shakeStartTimeMs: number,
  durationMs: number = 220,
  maxIntensity: number = 4
): { x: number; y: number } {
  const elapsed = currentTimeMs - shakeStartTimeMs;
  if (elapsed >= durationMs || elapsed < 0) {
    return { x: 0, y: 0 };
  }
  const decay = 1 - elapsed / durationMs;
  const intensity = maxIntensity * decay;
  const angle = (currentTimeMs * 0.05) % (Math.PI * 2);
  const x = Math.sin(angle * 7) * intensity;
  const y = Math.cos(angle * 11) * intensity;
  return { x, y };
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
 * Draws a stylized human Fist hand gesture (Búa - Clenched Fist ✊)
 */
function drawFistHandIcon(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  color: string
): void {
  ctx.save();
  ctx.translate(cx, cy + size * 0.05);

  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(15, 23, 42, 0.45)';
  ctx.lineWidth = Math.max(1.2, size * 0.04);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const s = size * 0.44;

  // Wrist
  ctx.beginPath();
  ctx.roundRect(-s * 0.42, s * 0.4, s * 0.84, s * 0.45, s * 0.15);
  ctx.fill();

  // Clenched Fist Main Block (rounded palm & 4 folded fingers)
  ctx.beginPath();
  ctx.roundRect(-s * 0.65, -s * 0.55, s * 1.3, s * 1.05, s * 0.35);
  ctx.fill();
  ctx.stroke();

  // 4 Finger Creases / Knuckles (Index, Middle, Ring, Pinky)
  const fingerW = (s * 1.3) / 4;
  for (let i = 1; i <= 3; i++) {
    const x = -s * 0.65 + i * fingerW;
    ctx.beginPath();
    ctx.moveTo(x, -s * 0.5);
    ctx.lineTo(x, -s * 0.05);
    ctx.stroke();
  }

  // Thumb folded horizontally across the fingers
  ctx.beginPath();
  ctx.roundRect(-s * 0.70, -s * 0.08, s * 1.15, s * 0.38, s * 0.18);
  ctx.fill();
  ctx.stroke();

  // Thumb knuckle crease
  ctx.beginPath();
  ctx.arc(-s * 0.25, s * 0.1, s * 0.1, -Math.PI * 0.4, Math.PI * 0.4);
  ctx.stroke();

  ctx.restore();
}

/**
 * Draws a stylized human Scissors hand gesture (Kéo - Two Fingers V-sign ✌️)
 */
function drawScissorsHandIcon(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  color: string
): void {
  ctx.save();
  ctx.translate(cx, cy + size * 0.08);

  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(15, 23, 42, 0.45)';
  ctx.lineWidth = Math.max(1.2, size * 0.04);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const s = size * 0.44;

  // Wrist
  ctx.beginPath();
  ctx.roundRect(-s * 0.35, s * 0.42, s * 0.70, s * 0.42, s * 0.15);
  ctx.fill();

  // Base palm (folded ring and pinky fingers)
  ctx.beginPath();
  ctx.roundRect(-s * 0.55, -s * 0.05, s * 1.10, s * 0.65, s * 0.25);
  ctx.fill();
  ctx.stroke();

  // Thumb folded over ring & pinky
  ctx.beginPath();
  ctx.roundRect(-s * 0.50, s * 0.10, s * 0.85, s * 0.32, s * 0.16);
  ctx.fill();
  ctx.stroke();

  // Finger 1 (Index Finger - leaning left ~15 deg)
  ctx.save();
  ctx.translate(-s * 0.18, 0);
  ctx.rotate(-0.25);
  ctx.beginPath();
  ctx.roundRect(-s * 0.15, -s * 1.05, s * 0.30, s * 1.1, s * 0.15);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // Finger 2 (Middle Finger - leaning right ~15 deg)
  ctx.save();
  ctx.translate(s * 0.18, 0);
  ctx.rotate(0.25);
  ctx.beginPath();
  ctx.roundRect(-s * 0.15, -s * 1.10, s * 0.30, s * 1.15, s * 0.15);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  ctx.restore();
}

/**
 * Draws a stylized human Paper hand gesture (Bao - Open Palm 5 Fingers ✋)
 */
function drawPaperHandIcon(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  color: string
): void {
  ctx.save();
  ctx.translate(cx, cy + size * 0.08);

  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(15, 23, 42, 0.45)';
  ctx.lineWidth = Math.max(1.2, size * 0.04);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const s = size * 0.44;

  // Wrist
  ctx.beginPath();
  ctx.roundRect(-s * 0.32, s * 0.42, s * 0.64, s * 0.42, s * 0.15);
  ctx.fill();

  // Palm base
  ctx.beginPath();
  ctx.roundRect(-s * 0.52, -s * 0.15, s * 1.04, s * 0.70, s * 0.22);
  ctx.fill();
  ctx.stroke();

  // Thumb (splayed to the left)
  ctx.save();
  ctx.translate(-s * 0.45, s * 0.15);
  ctx.rotate(-0.68);
  ctx.beginPath();
  ctx.roundRect(-s * 0.13, -s * 0.50, s * 0.26, s * 0.65, s * 0.13);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // Index finger
  ctx.save();
  ctx.translate(-s * 0.32, -s * 0.10);
  ctx.rotate(-0.16);
  ctx.beginPath();
  ctx.roundRect(-s * 0.12, -s * 0.85, s * 0.24, s * 0.90, s * 0.12);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // Middle finger (tallest, straight up)
  ctx.save();
  ctx.translate(-s * 0.04, -s * 0.12);
  ctx.beginPath();
  ctx.roundRect(-s * 0.12, -s * 0.98, s * 0.24, s * 1.02, s * 0.12);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // Ring finger
  ctx.save();
  ctx.translate(s * 0.22, -s * 0.10);
  ctx.rotate(0.12);
  ctx.beginPath();
  ctx.roundRect(-s * 0.12, -s * 0.86, s * 0.24, s * 0.90, s * 0.12);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // Pinky finger
  ctx.save();
  ctx.translate(s * 0.44, -s * 0.02);
  ctx.rotate(0.30);
  ctx.beginPath();
  ctx.roundRect(-s * 0.10, -s * 0.65, s * 0.20, s * 0.70, s * 0.10);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

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
  // Clear full canvas with Cyberpunk Dark Obsidian
  ctx.fillStyle = '#060a12';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  ctx.save();
  if (state.screenShakeOffset && (state.screenShakeOffset.x !== 0 || state.screenShakeOffset.y !== 0)) {
    ctx.translate(state.screenShakeOffset.x, state.screenShakeOffset.y);
  }

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
      drawFistHandIcon(ctx, screenX, screenY, iconSize, iconColor);
    } else if (p.type === PieceType.SCISSORS) {
      drawScissorsHandIcon(ctx, screenX, screenY, iconSize, iconColor);
    } else if (p.type === PieceType.PAPER) {
      drawPaperHandIcon(ctx, screenX, screenY, iconSize, iconColor);
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

  // ==========================================
  // Layer 7: Floating Combat Texts
  // ==========================================
  if (state.floatingTexts && state.floatingTexts.length > 0) {
    for (const item of state.floatingTexts) {
      ctx.save();
      ctx.globalAlpha = item.alpha;
      ctx.font = `900 ${Math.max(14, Math.round(tileSize * 0.36))}px 'JetBrains Mono', monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = item.color;
      ctx.shadowColor = item.color;
      ctx.shadowBlur = 12;
      ctx.fillText(item.text, item.x, item.y);
      ctx.restore();
    }
  }

  ctx.restore(); // Restore screen-shake translation
}
