'use client';

import { useState } from 'react';
import { HandPieceIcon } from '../replays/ReplayBoard';

interface PieceInfo {
  id: 'ROCK' | 'SCISSORS' | 'PAPER';
  name: string;
  defeats: string;
  defeatedBy: string;
  color: string;
}

const PIECES: Record<string, PieceInfo> = {
  ROCK: {
    id: 'ROCK',
    name: 'BÚA (ROCK)',
    defeats: 'Kéo (Scissors)',
    defeatedBy: 'Bao (Paper)',
    color: '#ece8e1',
  },
  SCISSORS: {
    id: 'SCISSORS',
    name: 'KÉO (SCISSORS)',
    defeats: 'Bao (Paper)',
    defeatedBy: 'Búa (Rock)',
    color: '#00f5d4',
  },
  PAPER: {
    id: 'PAPER',
    name: 'BAO (PAPER)',
    defeats: 'Búa (Rock)',
    defeatedBy: 'Kéo (Scissors)',
    color: '#ff4655',
  },
};

export default function TrinityBattleWheel() {
  const [selected, setSelected] = useState<PieceInfo>(PIECES.ROCK);

  return (
    <div className="relative flex flex-col items-center justify-center rounded-3xl border border-[var(--border-subtle)] bg-[var(--surface)]/80 p-6 shadow-xl backdrop-blur-md overflow-hidden">
      {/* Background glow behind wheel */}
      <div className="absolute inset-0 bg-radial-gradient from-[var(--action)]/5 via-transparent to-transparent pointer-events-none" />

      {/* Title chip */}
      <div className="flex items-center gap-2 mb-3 text-xs font-mono text-[var(--text-secondary)] uppercase tracking-wider">
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent-secondary)]" />
        <span>VÒNG TƯƠNG KHẮC CHIẾN THUẬT</span>
      </div>

      {/* Interactive SVG Wheel */}
      <div className="relative w-full max-w-[320px] aspect-[320/280]">
        <svg
          viewBox="0 0 320 280"
          className="w-full h-full select-none"
          role="img"
          aria-label="Vòng tròn tương khắc Búa, Kéo, Bao"
        >
          <defs>
            <filter id="glow-red-wheel" x="-30%" y="-30%" width="160%" height="160%">
              <feDropShadow dx="0" dy="0" stdDeviation="3.5" floodColor="#ff4655" floodOpacity="0.55" />
              <feDropShadow dx="0" dy="3" stdDeviation="3" floodColor="#000" floodOpacity="0.5" />
            </filter>
            <filter id="glow-cyan-wheel" x="-30%" y="-30%" width="160%" height="160%">
              <feDropShadow dx="0" dy="0" stdDeviation="3.5" floodColor="#00f5d4" floodOpacity="0.55" />
              <feDropShadow dx="0" dy="3" stdDeviation="3" floodColor="#000" floodOpacity="0.5" />
            </filter>
            <filter id="shadow-white-wheel" x="-30%" y="-30%" width="160%" height="160%">
              <feDropShadow dx="0" dy="4" stdDeviation="4" floodColor="#000" floodOpacity="0.5" />
            </filter>

            <marker id="arrow-cyan-w" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M 0 1 L 10 5 L 0 9 z" fill="#00f5d4" />
            </marker>
            <marker id="arrow-red-w" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M 0 1 L 10 5 L 0 9 z" fill="#ff4655" />
            </marker>
            <marker id="arrow-white-w" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M 0 1 L 10 5 L 0 9 z" fill="#ffffff" />
            </marker>
          </defs>

          {/* Animated Connecting Flow Arrows */}
          {/* 1. Rock defeats Scissors (Top to Bottom-Right) */}
          <path
            d="M 180 75 Q 230 115 240 170"
            stroke="#00f5d4"
            strokeWidth="2.5"
            strokeDasharray="6 4"
            fill="none"
            markerEnd="url(#arrow-cyan-w)"
            opacity={selected.id === 'ROCK' || selected.id === 'SCISSORS' ? 1 : 0.4}
          >
            <animate attributeName="stroke-dashoffset" values="20;0" dur="1.4s" repeatCount="indefinite" />
          </path>

          {/* 2. Scissors defeats Paper (Bottom-Right to Bottom-Left) */}
          <path
            d="M 215 220 Q 160 250 105 220"
            stroke="#ff4655"
            strokeWidth="2.5"
            strokeDasharray="6 4"
            fill="none"
            markerEnd="url(#arrow-red-w)"
            opacity={selected.id === 'SCISSORS' || selected.id === 'PAPER' ? 1 : 0.4}
          >
            <animate attributeName="stroke-dashoffset" values="20;0" dur="1.4s" repeatCount="indefinite" />
          </path>

          {/* 3. Paper defeats Rock (Bottom-Left to Top) */}
          <path
            d="M 80 170 Q 90 115 140 75"
            stroke="#ffffff"
            strokeWidth="2.5"
            strokeDasharray="6 4"
            fill="none"
            markerEnd="url(#arrow-white-w)"
            opacity={selected.id === 'PAPER' || selected.id === 'ROCK' ? 1 : 0.4}
          >
            <animate attributeName="stroke-dashoffset" values="20;0" dur="1.4s" repeatCount="indefinite" />
          </path>

          {/* Center Objective: Throne */}
          <g transform="translate(160, 145)">
            <circle r="30" fill="#0f1923" stroke="rgba(236,232,225,0.18)" strokeWidth="1.5" />
            <circle r="26" fill="none" stroke="rgba(255,70,85,0.4)" strokeWidth="1" strokeDasharray="4 2">
              <animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="14s" repeatCount="indefinite" />
            </circle>
            <text y="-4" textAnchor="middle" fill="#9aa6b1" fontFamily="sans-serif" fontSize="7.5" fontWeight="700" letterSpacing="0.5">
              MỤC TIÊU
            </text>
            <text y="10" textAnchor="middle" fill="#ffffff" fontFamily="sans-serif" fontSize="9.5" fontWeight="800">
              HOÀNG TOẠ
            </text>
          </g>

          {/* Node 1: Rock (Top 160, 50) */}
          <g
            transform="translate(160, 50)"
            className="cursor-pointer transition-transform duration-200 hover:scale-110"
            onClick={() => setSelected(PIECES.ROCK)}
            filter="url(#shadow-white-wheel)"
          >
            <circle
              r="26"
              fill="#ffffff"
              stroke={selected.id === 'ROCK' ? 'var(--action)' : '#cbd5e1'}
              strokeWidth={selected.id === 'ROCK' ? 3 : 1.5}
            />
            <HandPieceIcon kind="ROCK" x={0} y={0} size={23} fill="#0f1923" accentColor="#f8f9fa" />
          </g>

          {/* Node 2: Scissors (Bottom Right 250, 200) */}
          <g
            transform="translate(250, 200)"
            className="cursor-pointer transition-transform duration-200 hover:scale-110"
            onClick={() => setSelected(PIECES.SCISSORS)}
            filter="url(#glow-cyan-wheel)"
          >
            <circle
              r="26"
              fill="#121b24"
              stroke="#00f5d4"
              strokeWidth={selected.id === 'SCISSORS' ? 3 : 1.5}
            />
            <HandPieceIcon kind="SCISSORS" x={0} y={0} size={23} fill="#00f5d4" accentColor="#0b1118" />
          </g>

          {/* Node 3: Paper (Bottom Left 70, 200) */}
          <g
            transform="translate(70, 200)"
            className="cursor-pointer transition-transform duration-200 hover:scale-110"
            onClick={() => setSelected(PIECES.PAPER)}
            filter="url(#glow-red-wheel)"
          >
            <circle
              r="26"
              fill="#121b24"
              stroke="#ff4655"
              strokeWidth={selected.id === 'PAPER' ? 3 : 1.5}
            />
            <HandPieceIcon kind="PAPER" x={0} y={0} size={23} fill="#ff4655" accentColor="#0b1118" />
          </g>
        </svg>
      </div>

      {/* Selected Piece Info Card */}
      <div className="mt-4 w-full rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)] p-3.5 text-center transition-all">
        <p className="font-heading text-sm font-bold text-[var(--text-primary)]">
          {selected.name}
        </p>
        <div className="mt-1 flex items-center justify-center gap-3 text-xs">
          <span className="text-[var(--success-text)] font-medium">
            Thắng: <strong>{selected.defeats}</strong>
          </span>
          <span className="text-[var(--text-faint)]">·</span>
          <span className="text-[var(--danger-text)] font-medium">
            Thua: <strong>{selected.defeatedBy}</strong>
          </span>
        </div>
      </div>
    </div>
  );
}
