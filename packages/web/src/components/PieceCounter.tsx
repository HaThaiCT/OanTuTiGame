import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { PieceType, PlayerSide } from '@oantuti/engine';
import { PieceState } from '../replay/player.js';

interface PieceCounterProps {
  readonly pieces: readonly PieceState[];
  readonly whiteBotName: string;
  readonly blackBotName: string;
}

export const PieceCounter: React.FC<PieceCounterProps> = ({
  pieces,
  whiteBotName,
  blackBotName,
}) => {
  const countPieces = (side: PlayerSide) => {
    const living = pieces.filter((p) => p.isAlive && p.owner === side);
    const rocks = living.filter((p) => p.type === PieceType.ROCK).length;
    const scissors = living.filter((p) => p.type === PieceType.SCISSORS).length;
    const papers = living.filter((p) => p.type === PieceType.PAPER).length;
    const total = living.length;
    const isEndangered = rocks === 1 || scissors === 1 || papers === 1;
    return { rocks, scissors, papers, total, isEndangered };
  };

  const white = countPieces(PlayerSide.WHITE);
  const black = countPieces(PlayerSide.BLACK);

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: '12px',
      padding: '16px',
      backgroundColor: '#0f172a',
      borderRadius: '12px',
      border: '1px solid #1e293b',
    }}>
      {/* White Side */}
      <div style={{
        backgroundColor: '#141d2d',
        borderRadius: '8px',
        padding: '12px',
        border: '1px solid #1e293b',
        borderLeft: '4px solid #38bdf8',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
          <div>
            <div style={{ fontSize: '11px', color: '#64748b', textTransform: 'uppercase', fontWeight: 700 }}>
              White Side
            </div>
            <div style={{ fontSize: '14px', fontWeight: 800, color: '#38bdf8' }}>
              {whiteBotName}
            </div>
          </div>
          <div style={{ fontSize: '20px', fontWeight: 800, color: '#f1f5f9' }}>
            {white.total}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '8px' }}>
          <Badge type="ROCK" count={white.rocks} color="#38bdf8" />
          <Badge type="SCISSORS" count={white.scissors} color="#38bdf8" />
          <Badge type="PAPER" count={white.papers} color="#38bdf8" />
        </div>

        {white.isEndangered && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '8px', color: '#f59e0b', fontSize: '11px', fontWeight: 600 }}>
            <AlertTriangle size={12} />
            <span>Species at risk of extinction!</span>
          </div>
        )}
      </div>

      {/* Black Side */}
      <div style={{
        backgroundColor: '#141d2d',
        borderRadius: '8px',
        padding: '12px',
        border: '1px solid #1e293b',
        borderLeft: '4px solid #f43f5e',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
          <div>
            <div style={{ fontSize: '11px', color: '#64748b', textTransform: 'uppercase', fontWeight: 700 }}>
              Black Side
            </div>
            <div style={{ fontSize: '14px', fontWeight: 800, color: '#f43f5e' }}>
              {blackBotName}
            </div>
          </div>
          <div style={{ fontSize: '20px', fontWeight: 800, color: '#f1f5f9' }}>
            {black.total}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '8px' }}>
          <Badge type="ROCK" count={black.rocks} color="#f43f5e" />
          <Badge type="SCISSORS" count={black.scissors} color="#f43f5e" />
          <Badge type="PAPER" count={black.papers} color="#f43f5e" />
        </div>

        {black.isEndangered && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '8px', color: '#f59e0b', fontSize: '11px', fontWeight: 600 }}>
            <AlertTriangle size={12} />
            <span>Species at risk of extinction!</span>
          </div>
        )}
      </div>
    </div>
  );
};

const Badge: React.FC<{ type: 'ROCK' | 'SCISSORS' | 'PAPER'; count: number; color: string }> = ({
  type,
  count,
  color,
}) => {
  const isDanger = count === 1;
  const title = type === 'ROCK' ? 'Búa (Nắm đấm ✊)' : type === 'SCISSORS' ? 'Kéo (Hai ngón ✌️)' : 'Bao (Bàn tay xòe ✋)';
  const emoji = type === 'ROCK' ? '✊' : type === 'SCISSORS' ? '✌️' : '✋';
  const label = type === 'ROCK' ? 'Búa' : type === 'SCISSORS' ? 'Kéo' : 'Bao';

  return (
    <div
      title={title}
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: '#0f172a',
        borderRadius: '6px',
        padding: '5px 8px',
        border: isDanger ? '1px solid #f59e0b' : '1px solid #1e293b',
        gap: '4px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
        <span style={{ fontSize: '14px', lineHeight: 1 }}>{emoji}</span>
        <span style={{ fontSize: '11px', fontWeight: 700, color }}>{label}</span>
      </div>
      <span style={{ fontSize: '13px', fontWeight: 800, color: count === 0 ? '#475569' : '#f1f5f9' }}>
        {count}
      </span>
    </div>
  );
};
