'use client';
import Link from 'next/link';
import { useId, useState } from 'react';
import type { TournamentSummary } from '../../lib/api';
import { formatLabel, stateLabel } from '../../lib/labels';
import { HandPieceIcon } from '../replays/ReplayBoard';
const formats = [
  { id: 'ALL', label: 'Tất cả', color: 'var(--text-secondary)' },
  { id: 'SINGLE_ELIMINATION', label: 'Loại trực tiếp', color: '#ff4655' },
  { id: 'SWISS_PLAYOFF', label: 'Swiss - Playoff', color: '#00f5d4' },
  { id: 'ROUND_ROBIN', label: 'Vòng tròn', color: '#38bdf8' },
  { id: 'ELO_ARENA', label: 'Elo Arena', color: '#f5a524' },
];

export default function TournamentCatalog({ tournaments }: { tournaments: TournamentSummary[] }) {
  const [query, setQuery] = useState('');
  const [format, setFormat] = useState('ALL');
  const [page, setPage] = useState(0);
  const visible = tournaments.filter(
    t =>
      (format === 'ALL' || t.format === format) &&
      t.name.toLocaleLowerCase('vi').includes(query.toLocaleLowerCase('vi')),
  );
  const pageCount = Math.max(1, Math.ceil(visible.length / 4));
  const currentPage = Math.min(page, pageCount - 1);

  return (
    <section id="tournaments" aria-label="Giải đấu OanTuTi">
      <div className="arena-search">
        <input
          aria-label="Tìm giải đấu"
          placeholder="Tìm kiếm giải đấu..."
          value={query}
          onChange={e => {
            setQuery(e.target.value);
            setPage(0);
          }}
        />
        <button
          type="button"
          className="vct-btn-secondary !py-1.5 !px-4 !text-xs !rounded-full"
          onClick={() => {
            setQuery('');
            setFormat('ALL');
            setPage(0);
          }}
        >
          Tất cả
        </button>
      </div>

      <div className="arena-filters" aria-label="Lọc thể thức">
        {formats.map(f => (
          <button
            key={f.id}
            type="button"
            style={{ color: format === f.id ? undefined : f.color }}
            aria-pressed={format === f.id}
            onClick={() => {
              setFormat(f.id);
              setPage(0);
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="arena-section-heading">
        <h2>
          Giải đấu hiện hành
        </h2>
        <div className="arena-pagination">
          <span aria-live="polite">
            {visible.length} giải · Trang {currentPage + 1}/{pageCount}
          </span>
          <button
            aria-label="Trang giải trước"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            ◄
          </button>
          <button
            aria-label="Trang giải tiếp"
            disabled={currentPage >= pageCount - 1}
            onClick={() => setPage(currentPage + 1)}
          >
            ►
          </button>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="arena-empty">
          {tournaments.length === 0 ? 'Chưa có giải đấu nào được công bố.' : 'Không có giải phù hợp bộ lọc.'}
        </div>
      ) : (
        <div className="arena-catalog">
          {visible.slice(currentPage * 4, currentPage * 4 + 4).map((t, index) => (
            <Link className="arena-tournament-card" key={t.id} href={`/tournaments/${t.id}`}>
              <div className="arena-tournament-card-art">
                <BoardArtwork variant={index % 4} />
              </div>
              <div className="px-4 pt-3 flex items-center justify-between">
                <span
                  className={
                    t.isRated
                      ? 'bg-[var(--action)] text-white font-mono text-[10px] font-bold tracking-widest px-2.5 py-0.5 rounded-full shadow-sm'
                      : 'bg-[var(--surface-subtle)] text-[var(--text-secondary)] border border-[var(--border-subtle)] font-mono text-[10px] tracking-widest px-2.5 py-0.5 rounded-full'
                  }
                  title={t.globalRatingPolicy}
                >
                  {t.isRated ? 'RATED' : 'UNRATED'}
                </span>
                <span className="font-mono text-[10px] text-[var(--text-faint)]">
                  {t.rulesRevision}
                </span>
              </div>
              <div className="arena-tournament-card-body">
                <span
                  className={`arena-status ${
                    t.state === 'RUNNING' ? 'text-[var(--action)] font-bold' : ''
                  }`}
                >
                  {t.state === 'RUNNING' ? (
                    <span className="beacon-pulse mr-2" />
                  ) : (
                    <span className="inline-block w-1.5 h-1.5 rounded-full mr-2 bg-current opacity-60" />
                  )}
                  {stateLabel[t.state] ?? t.state}
                </span>
                <h3>{t.name}</h3>
                <p className="mt-1 text-xs text-[var(--text-secondary)] uppercase tracking-wide font-mono">
                  {formatLabel[t.format] ?? t.format}
                </p>
                <div className="arena-card-meta">
                  <span>Tối đa {t.maxTeams} đội</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

function BoardArtwork({ variant }: { variant: number }) {
  const glowId = useId();
  const accents = ['#ff4655', '#00f5d4', '#f5a524', '#38bdf8'];
  const accent = accents[variant];

  return (
    <svg
      viewBox="0 0 320 180"
      role="img"
      aria-label="Minh họa bàn cờ OanTuTi phong cách Valorant Esports"
      className="w-full h-full"
    >
      <defs>
        <radialGradient id={glowId} cx="50%" cy="50%" r="60%">
          <stop offset="0%" stopColor={accent} stopOpacity="0.25" />
          <stop offset="100%" stopColor="#0b1118" stopOpacity="0.95" />
        </radialGradient>
        <pattern id={`grid-${variant}`} width="16" height="16" patternUnits="userSpaceOnUse">
          <path d="M 16 0 L 0 0 0 16" fill="none" stroke="rgba(236, 232, 225, 0.05)" strokeWidth="0.5" />
        </pattern>
      </defs>

      <rect width="320" height="180" fill="#0b1118" />
      <rect width="320" height="180" fill={`url(#${glowId})`} />
      <rect width="320" height="180" fill={`url(#grid-${variant})`} />

      {/* Coordinate HUD Marks */}
      <text x="12" y="20" fill="rgba(236,232,225,0.4)" fontSize="9" fontFamily="monospace" letterSpacing="1">
        SEC-0{variant + 1}
      </text>
      <text x="260" y="20" fill="rgba(236,232,225,0.4)" fontSize="9" fontFamily="monospace" letterSpacing="1">
        0x7F.{variant}A
      </text>
      <line x1="10" y1="26" x2="310" y2="26" stroke="rgba(236, 232, 225, 0.1)" strokeWidth="1" />

      {/* Isometric Tactical Board */}
      <g transform="translate(160 98) rotate(-22) skewX(14) translate(-90 -65)">
        {Array.from({ length: 64 }, (_, i) => {
          const row = Math.floor(i / 8);
          const col = i % 8;
          const isEven = (row + col) % 2 === 0;
          return (
            <rect
              key={i}
              x={col * 22}
              y={row * 16}
              width="21"
              height="15"
              rx="3"
              fill={isEven ? '#17202a' : '#101720'}
              stroke={isEven ? 'rgba(236, 232, 225, 0.08)' : 'rgba(236, 232, 225, 0.04)'}
              strokeWidth="0.75"
            />
          );
        })}

        {/* Combat Pieces */}
        {[9, 18, 10, 45, 54, 53].map((pos, i) => {
          const row = Math.floor(pos / 8);
          const col = pos % 8;
          const isTeamWhite = i < 3;
          const pieceColor = isTeamWhite ? '#ffffff' : '#121b24';
          const strokeColor = isTeamWhite ? '#cbd5e1' : accent;
          const kind = ['ROCK', 'SCISSORS', 'PAPER'][i % 3];
          const handFill = isTeamWhite ? '#0f1923' : accent;
          return (
            <g key={pos} transform={`translate(${col * 22 + 11} ${row * 16 + 8})`}>
              <circle
                r="7.5"
                fill={pieceColor}
                stroke={strokeColor}
                strokeWidth="1.2"
              />
              <HandPieceIcon
                kind={kind}
                x={0}
                y={0}
                size={10}
                fill={handFill}
              />
            </g>
          );
        })}
      </g>

      {/* Corner crosshairs */}
      <path d="M 6 170 L 16 170 M 6 160 L 6 170" stroke={accent} strokeWidth="1.5" fill="none" />
      <path d="M 314 170 L 304 170 M 314 160 L 314 170" stroke={accent} strokeWidth="1.5" fill="none" />
    </svg>
  );
}
