import type { ReplayFrame, ReplayMapDescriptor } from '../../lib/replay';

/** Board geometry in SVG user units; the element scales with its container via `viewBox`. */
const TILE = 46;
const PAD = 10;

const PIECE_INITIAL: Record<string, string> = { ROCK: 'R', SCISSORS: 'S', PAPER: 'P' };

/**
 * A single replay position drawn on the map from the payload: valid tiles, both thrones, every
 * surviving piece (owner colour + R/P/S initial), the piece that just moved and the capture it made.
 * Purely presentational — the parent decides which frame is current.
 */
export default function ReplayBoard({
  descriptor,
  frame,
}: {
  descriptor: ReplayMapDescriptor;
  frame: ReplayFrame;
}) {
  const width = descriptor.width * TILE + PAD * 2;
  const height = descriptor.height * TILE + PAD * 2;
  const centerX = (x: number) => PAD + x * TILE + TILE / 2;
  const centerY = (y: number) => PAD + y * TILE + TILE / 2;

  const movedPiece = frame.movedPieceId === null
    ? null
    : frame.pieces.find((piece) => piece.id === frame.movedPieceId && piece.alive) ?? null;
  const living = frame.pieces.filter((piece) => piece.alive);
  const thrones = [
    { key: 'white', pos: descriptor.whiteThrone, fill: 'rgba(248,250,252,0.16)', stroke: 'var(--text-primary)' },
    { key: 'black', pos: descriptor.blackThrone, fill: 'rgba(253,186,116,0.12)', stroke: '#FDBA74' },
  ];

  return (
    <figure className="flex flex-col gap-3">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--canvas)]"
        role="img"
        aria-label={`Bàn đấu ${descriptor.mapName}`}
      >
        {descriptor.validTiles.map(([x, y]) => (
          <rect
            key={`tile-${x}-${y}`}
            x={PAD + x * TILE}
            y={PAD + y * TILE}
            width={TILE}
            height={TILE}
            rx={2}
            fill="#292a2d"
            stroke="#45464a"
            strokeWidth={1}
          />
        ))}

        {thrones.map((throne) => (
          <rect
            key={`throne-${throne.key}`}
            x={PAD + throne.pos[0] * TILE + 1}
            y={PAD + throne.pos[1] * TILE + 1}
            width={TILE - 2}
            height={TILE - 2}
            rx={2}
            fill={throne.fill}
            stroke={throne.stroke}
            strokeWidth={2}
            strokeDasharray="5 3"
          />
        ))}

        {movedPiece ? (
          <rect
            x={PAD + movedPiece.x * TILE}
            y={PAD + movedPiece.y * TILE}
            width={TILE}
            height={TILE}
            rx={2}
            fill="none"
            stroke="var(--live-accent)"
            strokeWidth={3}
          />
        ) : null}

        {frame.captured ? (
          <g stroke="var(--danger-text)" strokeWidth={3} strokeLinecap="round">
            <line
              x1={centerX(frame.captured.x) - TILE * 0.24}
              y1={centerY(frame.captured.y) - TILE * 0.24}
              x2={centerX(frame.captured.x) + TILE * 0.24}
              y2={centerY(frame.captured.y) + TILE * 0.24}
            />
            <line
              x1={centerX(frame.captured.x) + TILE * 0.24}
              y1={centerY(frame.captured.y) - TILE * 0.24}
              x2={centerX(frame.captured.x) - TILE * 0.24}
              y2={centerY(frame.captured.y) + TILE * 0.24}
            />
          </g>
        ) : null}

        {living.map((piece) => (
          <g key={`piece-${piece.id}`}>
            {piece.id === frame.movedPieceId ? (
              <circle
                cx={centerX(piece.x)}
                cy={centerY(piece.y)}
                r={TILE * 0.42}
                fill="none"
                stroke="var(--live-accent)"
                strokeWidth={3}
              />
            ) : null}
            <circle
              cx={centerX(piece.x)}
              cy={centerY(piece.y)}
              r={TILE * 0.34}
              fill={piece.owner === 'WHITE' ? '#F8FAFC' : '#1F2937'}
              stroke={piece.owner === 'WHITE' ? '#94A3B8' : 'var(--border-control)'}
              strokeWidth={1.5}
            />
            <text
              x={centerX(piece.x)}
              y={centerY(piece.y)}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={TILE * 0.38}
              fontWeight={700}
              fill={piece.owner === 'WHITE' ? '#0B0D17' : '#F8FAFC'}
            >
              {PIECE_INITIAL[piece.kind] ?? '?'}
            </text>
          </g>
        ))}
      </svg>

      <figcaption className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-[var(--text-secondary)]">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-full border border-[#94A3B8] bg-[#F8FAFC]" /> Quân Trắng
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-full bg-[#1F2937] ring-1 ring-[var(--border-control)]" /> Quân Đen
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded border-2 border-dashed border-[var(--text-primary)]" /> Ngai Trắng
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded border-2 border-dashed border-[#FDBA74]" /> Ngai Đen
        </span>
        <span>R = Rock · S = Scissors · P = Paper</span>
        <span className="text-[var(--live-accent)]">◯ quân vừa đi</span>
        <span className="text-[var(--danger-text)]">✕ quân bị ăn</span>
      </figcaption>
    </figure>
  );
}
