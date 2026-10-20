import type { ReplayFrame, ReplayMapDescriptor } from '../../lib/replay';

/** Board geometry in SVG user units; the element scales with its container via `viewBox`. */
const TILE = 46;
const PAD = 10;

export function HandPieceIcon({
  kind,
  x,
  y,
  size = 21,
  fill,
  accentColor,
}: {
  kind: string;
  x: number;
  y: number;
  size?: number;
  fill: string;
  accentColor?: string;
}) {
  const scale = size / 32;
  const tx = x - 16 * scale;
  const ty = y - 16 * scale;

  if (kind === 'ROCK') {
    return (
      <g transform={`translate(${tx} ${ty}) scale(${scale})`}>
        <path
          d="M11 27 C8 27 6.5 24.5 6.5 21.5 L6.5 17.5 C5.2 17 4 15.5 4 13.5 C4 11 6 9.5 8 10 C8.3 8 10 6.5 12.5 6.5 C13.3 6.5 14.1 6.8 14.8 7.3 C15.5 6.3 17 5.8 18.5 6 C20 6.3 21.2 7.5 21.5 9 C22.2 8.5 23.2 8.5 24 9 C25.5 10 26 11.8 26 13.5 C26 19 23 27 16 27 Z"
          fill={fill}
        />
        {accentColor ? (
          <path
            d="M13 13 C15 13 20 13.5 23 16 M6.5 13.5 C8.5 14 12 15.5 13 18.5 M12.5 6.5 L13 12.5 M18.5 6 L19 12.5 M22 9 L22.5 13.5"
            fill="none"
            stroke={accentColor}
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
      </g>
    );
  }

  if (kind === 'SCISSORS') {
    return (
      <g transform={`translate(${tx} ${ty}) scale(${scale})`}>
        <path
          d="M9 3 C7.5 3 6.5 4.2 6.8 5.8 L9.8 15.5 C8.8 16 7.8 17 7.8 18.5 C7.8 20 8.8 21.5 10.2 22.5 L11.2 27 L18.5 27 L19.5 22.8 C21.5 21.2 23 19.2 23 17 C23 15 21.5 13.5 19.5 13.8 L18.8 12.5 L21 5.2 C21.5 3.8 20.5 2.2 19 2.2 C17.8 2.2 16.8 3.2 16.4 4.5 L14 13.2 L11.5 4.2 C11 3.2 10 2.8 9 3 Z"
          fill={fill}
        />
        {accentColor ? (
          <path
            d="M9.5 17.5 C11 17.5 14 19 16.5 19 M18.5 14 C16.5 15.5 14.5 18.5 14 22.5"
            fill="none"
            stroke={accentColor}
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        ) : null}
      </g>
    );
  }

  // PAPER
  return (
    <g transform={`translate(${tx} ${ty}) scale(${scale})`}>
      <path
        d="M5 12.5 C4 11.5 4 10 5 9 C6 8 7.5 8.2 8.5 9.2 L10 11 L10 3.5 C10 2 11 1 12.2 1 C13.5 1 14.5 2 14.5 3.5 L14.5 9.5 L15 2 C15 0.8 16 0 17.2 0 C18.5 0 19.5 0.8 19.5 2 L19.5 9.8 L20 3.5 C20 2 21 1 22.2 1 C23.5 1 24.5 2 24.5 3.5 L24.5 11.5 L25 7 C25 5.5 26 4.5 27.2 4.5 C28.5 4.5 29.5 5.5 29.5 7 C29.5 12.5 26.5 19.5 23 23.5 L19.5 27 L13.5 27 L10 22 C8 19 6.2 14.5 5 12.5 Z"
        fill={fill}
      />
      {accentColor ? (
        <path
          d="M11.5 15.5 C14.5 16.5 18.5 16.5 22.5 14.5 M10.5 19.5 C13.5 20.5 17.5 21 20.5 18.5"
          fill="none"
          stroke={accentColor}
          strokeWidth="1.2"
          strokeLinecap="round"
        />
      ) : null}
    </g>
  );
}
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
    { key: 'white', pos: descriptor.whiteThrone, fill: 'rgba(236,232,225,0.14)', stroke: '#ece8e1' },
    { key: 'black', pos: descriptor.blackThrone, fill: 'rgba(0,245,212,0.14)', stroke: '#00f5d4' },
  ];

  return (
    <figure className="flex flex-col gap-3 scroll-mt-24">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full border border-[var(--border-subtle)] bg-[#0b1118] rounded-2xl shadow-sm"
        role="img"
        aria-label={`Bàn đấu ${descriptor.mapName}`}
      >
        <defs>
          <filter id="piece-shadow" x="-30%" y="-30%" width="160%" height="160%">
            <feDropShadow dx="0" dy="2.5" stdDeviation="2.5" floodColor="#000000" floodOpacity="0.55" />
          </filter>
          <filter id="cyan-glow" x="-30%" y="-30%" width="160%" height="160%">
            <feDropShadow dx="0" dy="0" stdDeviation="3.5" floodColor="#00f5d4" floodOpacity="0.45" />
            <feDropShadow dx="0" dy="2.5" stdDeviation="2.5" floodColor="#000000" floodOpacity="0.55" />
          </filter>
        </defs>

        {descriptor.validTiles.map(([x, y]) => {
          const isEven = (x + y) % 2 === 0;
          return (
            <rect
              key={`tile-${x}-${y}`}
              className="board-tile"
              x={PAD + x * TILE}
              y={PAD + y * TILE}
              width={TILE}
              height={TILE}
              rx={6}
              fill={isEven ? '#1a2530' : '#131b24'}
              stroke={isEven ? 'rgba(236, 232, 225, 0.09)' : 'rgba(236, 232, 225, 0.04)'}
              strokeWidth={1}
            />
          );
        })}
        {thrones.map((throne) => (
          <rect
            key={`throne-${throne.key}`}
            x={PAD + throne.pos[0] * TILE + 1}
            y={PAD + throne.pos[1] * TILE + 1}
            width={TILE - 2}
            height={TILE - 2}
            rx={8}
            fill={throne.fill}
            stroke={throne.stroke}
            strokeWidth={2}
            strokeDasharray="6 3"
          >
            <animate
              attributeName="stroke-dashoffset"
              values="0;18"
              dur="3s"
              repeatCount="indefinite"
            />
          </rect>
        ))}

        {movedPiece ? (
          <rect
            x={PAD + movedPiece.x * TILE}
            y={PAD + movedPiece.y * TILE}
            width={TILE}
            height={TILE}
            rx={6}
            fill="rgba(255, 70, 85, 0.12)"
            stroke="var(--action)"
            strokeWidth={2.5}
          />
        ) : null}

        {frame.captured ? (
          <g>
            <circle
              cx={centerX(frame.captured.x)}
              cy={centerY(frame.captured.y)}
              r={TILE * 0.38}
              fill="rgba(255, 70, 85, 0.18)"
              stroke="var(--danger-text)"
              strokeWidth={1.5}
            >
              <animate
                attributeName="r"
                values={`${TILE * 0.30};${TILE * 0.45};${TILE * 0.30}`}
                dur="1.8s"
                repeatCount="indefinite"
              />
              <animate
                attributeName="opacity"
                values="0.9;0.25;0.9"
                dur="1.8s"
                repeatCount="indefinite"
              />
            </circle>
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
          </g>
        ) : null}

        {living.map((piece) => {
          const isWhite = piece.owner === 'WHITE';
          const handFill = isWhite ? '#0f1923' : '#00f5d4';
          const handAccent = isWhite ? '#f8f9fa' : '#0b1118';
          return (
            <g key={`piece-${piece.id}`} className="board-piece" filter={isWhite ? 'url(#piece-shadow)' : 'url(#cyan-glow)'}>
              {piece.id === frame.movedPieceId ? (
                <g>
                  <circle
                    cx={centerX(piece.x)}
                    cy={centerY(piece.y)}
                    r={TILE * 0.44}
                    fill="none"
                    stroke="var(--action)"
                    strokeWidth={1.5}
                  >
                    <animate
                      attributeName="r"
                      values={`${TILE * 0.40};${TILE * 0.52};${TILE * 0.40}`}
                      dur="2.4s"
                      repeatCount="indefinite"
                    />
                    <animate
                      attributeName="opacity"
                      values="0.9;0.15;0.9"
                      dur="2.4s"
                      repeatCount="indefinite"
                    />
                  </circle>
                  <circle
                    cx={centerX(piece.x)}
                    cy={centerY(piece.y)}
                    r={TILE * 0.42}
                    fill="none"
                    stroke="var(--action)"
                    strokeWidth={2.5}
                  />
                </g>
              ) : null}
              <circle
                cx={centerX(piece.x)}
                cy={centerY(piece.y)}
                r={TILE * 0.35}
                fill={isWhite ? '#ffffff' : '#121b24'}
                stroke={isWhite ? '#cbd5e1' : '#00f5d4'}
                strokeWidth={1.5}
              />
              <circle
                cx={centerX(piece.x)}
                cy={centerY(piece.y)}
                r={TILE * 0.30}
                fill="none"
                stroke={isWhite ? 'rgba(0,0,0,0.06)' : 'rgba(0,245,212,0.2)'}
                strokeWidth={1}
              />
              <HandPieceIcon
                kind={piece.kind}
                x={centerX(piece.x)}
                y={centerY(piece.y)}
                size={21}
                fill={handFill}
                accentColor={handAccent}
              />
            </g>
          );
        })}
      </svg>

      <figcaption className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-[var(--text-secondary)]">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3.5 w-3.5 rounded-full border border-[#cbd5e1] bg-white shadow-xs" /> Quân Trắng
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3.5 w-3.5 rounded-full border border-[#00f5d4] bg-[#121b24] shadow-xs" /> Quân Đen
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3.5 w-3.5 rounded-md border border-dashed border-[#ece8e1]" /> Ngai Trắng
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3.5 w-3.5 rounded-md border border-dashed border-[#00f5d4]" /> Ngai Đen
        </span>
        <span className="flex items-center gap-2 text-[var(--text-primary)] font-semibold">
          <span>✊ Búa</span> · <span>✌️ Kéo</span> · <span>🖐️ Bao</span>
        </span>
        <span className="text-[var(--action)] font-medium">● Vừa đi</span>
        <span className="text-[var(--danger-text)] font-medium">✕ Bị ăn</span>
      </figcaption>
    </figure>
  );
}
