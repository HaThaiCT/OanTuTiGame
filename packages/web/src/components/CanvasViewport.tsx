import React from 'react';
import { Coord } from '@oantuti/engine';
import {
  calculateViewportTransform,
  screenToBoard,
  ViewportTransform,
} from '../canvas/viewport.js';
import {
  renderCanvasFrame,
  RenderState,
  RenderPiece,
  Particle,
  updateParticles,
  createCaptureParticles,
  FloatingCombatText,
  createFloatingText,
  updateFloatingTexts,
  calculateScreenShakeOffset,
} from '../canvas/renderer.js';
import { soundManager } from '../audio/sound-effects.js';

interface CanvasViewportProps {
  readonly boardWidth: number;
  readonly boardHeight: number;
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
  readonly onTileClick?: (coord: Coord) => void;
}

export const CanvasViewport: React.FC<CanvasViewportProps> = ({
  boardWidth,
  boardHeight,
  validTiles,
  whiteThrone,
  blackThrone,
  pieces,
  lastMove,
  onTileClick,
}) => {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const particlesRef = React.useRef<Particle[]>([]);
  const floatingTextsRef = React.useRef<FloatingCombatText[]>([]);
  const shakeStartTimeRef = React.useRef<number>(0);
  const prevLastMoveRef = React.useRef(lastMove);
  const moveAnimRef = React.useRef<{
    pieceId: number;
    from: Coord;
    to: Coord;
    startTime: number;
    duration: number;
  } | null>(null);

  const [hoveredCoord, setHoveredCoord] = React.useState<Coord | undefined>();
  const [selectedPieceId, setSelectedPieceId] = React.useState<number | undefined>();
  const transformRef = React.useRef<ViewportTransform | null>(null);
  // Spawn capture particles and start move animation if new lastMove
  React.useEffect(() => {
    if (lastMove && lastMove !== prevLastMoveRef.current) {
      moveAnimRef.current = {
        pieceId: lastMove.pieceId,
        from: lastMove.from,
        to: lastMove.to,
        startTime: performance.now(),
        duration: 280,
      };

      if (lastMove.isCapture) {
        soundManager.playCapture();
        shakeStartTimeRef.current = performance.now();
        if (transformRef.current) {
          const transform = transformRef.current;
          const center = {
            x: transform.offsetX + (lastMove.to.x + 0.5) * transform.tileSize,
            y: transform.offsetY + (lastMove.to.y + 0.5) * transform.tileSize,
          };
          const newParticles = createCaptureParticles(center.x, center.y);
          particlesRef.current.push(...newParticles);
          createFloatingText(floatingTextsRef.current, 'KILL!', center.x, center.y - 10, '#ef4444');
        }
      } else {
        soundManager.playMove();
      }
    }
    prevLastMoveRef.current = lastMove;
  }, [lastMove]);
  React.useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    let animId: number;

    const render = (time: number) => {
      try {
        const ctx = canvas.getContext('2d');
        if (ctx) {
        // Handle High-DPI canvas
        const rect = container.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;

        if (
          canvas.width !== Math.round(rect.width * dpr) ||
          canvas.height !== Math.round(rect.height * dpr)
        ) {
          canvas.width = Math.round(rect.width * dpr);
          canvas.height = Math.round(rect.height * dpr);
        }

        ctx.save();
        ctx.scale(dpr, dpr);

        const transform = calculateViewportTransform(
          rect.width,
          rect.height,
          boardWidth,
          boardHeight,
          32
        );
        transformRef.current = transform;

        updateParticles(particlesRef.current);
        updateFloatingTexts(floatingTextsRef.current);
        const screenShakeOffset = calculateScreenShakeOffset(time, shakeStartTimeRef.current, 240, 5);

        const animatedPieces = pieces.map((p) => {
          if (moveAnimRef.current && p.id === moveAnimRef.current.pieceId) {
            const elapsed = time - moveAnimRef.current.startTime;
            const progress = Math.min(1, Math.max(0, elapsed / moveAnimRef.current.duration));
            return {
              ...p,
              animStartX: moveAnimRef.current.from.x,
              animStartY: moveAnimRef.current.from.y,
              animProgress: progress,
            };
          }
          return p;
        });

        const renderState: RenderState = {
          width: boardWidth,
          height: boardHeight,
          validTiles,
          whiteThrone,
          blackThrone,
          pieces: animatedPieces,
          lastMove,
          selectedPieceId,
          hoveredCoord,
          animTimeMs: time,
          particles: particlesRef.current,
          floatingTexts: floatingTextsRef.current,
          screenShakeOffset,
        };

          renderCanvasFrame(ctx, transform, renderState);
          ctx.restore();
        }
      } catch (err) {
        console.error('Canvas frame render error:', err);
      } finally {
        animId = requestAnimationFrame(render);
      }
    };

    animId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animId);
    };
  }, [boardWidth, boardHeight, validTiles, whiteThrone, blackThrone, pieces, lastMove, hoveredCoord, selectedPieceId]);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!transformRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const boardPos = screenToBoard(mouseX, mouseY, transformRef.current);
    if (boardPos.isInBounds) {
      setHoveredCoord({ x: boardPos.x, y: boardPos.y });
    } else {
      setHoveredCoord(undefined);
    }
  };

  const handleMouseLeave = () => {
    setHoveredCoord(undefined);
  };

  const handleClick = () => {
    if (hoveredCoord) {
      const piece = pieces.find((p) => p.isAlive && p.x === hoveredCoord.x && p.y === hoveredCoord.y);
      if (piece) {
        setSelectedPieceId(piece.id === selectedPieceId ? undefined : piece.id);
      } else {
        setSelectedPieceId(undefined);
      }
      onTileClick?.(hoveredCoord);
    }
  };

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        overflow: 'hidden',
        backgroundColor: '#0f172a',
      }}
    >
      <canvas
        ref={canvasRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
        style={{
          width: '100%',
          height: '100%',
          display: 'block',
          cursor: hoveredCoord ? 'pointer' : 'default',
        }}
      />
    </div>
  );
};
