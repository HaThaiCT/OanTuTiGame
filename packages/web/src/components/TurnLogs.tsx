import React from 'react';
import { PlayerSide } from '@oantuti/engine';
import { ReplayTurnSnapshot } from '../replay/player.js';

interface TurnLogsProps {
  readonly snapshots: readonly ReplayTurnSnapshot[];
  readonly currentTurn: number;
  readonly onSelectTurn: (turn: number) => void;
}

export const TurnLogs: React.FC<TurnLogsProps> = ({
  snapshots,
  currentTurn,
  onSelectTurn,
}) => {
  const listRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (listRef.current) {
      const activeItem = listRef.current.querySelector('[data-active="true"]');
      if (activeItem) {
        activeItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }, [currentTurn]);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      backgroundColor: '#0f172a',
      borderRadius: '12px',
      border: '1px solid #1e293b',
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid #1e293b',
        fontWeight: 700,
        fontSize: '13px',
        color: '#94a3b8',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <span>MATCH TURN LOGS</span>
        <span style={{ fontSize: '11px', color: '#64748b' }}>{snapshots.length - 1} turns</span>
      </div>

      <div
        ref={listRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '8px',
          display: 'flex',
          flexDirection: 'column',
          gap: '4px',
        }}
      >
        {snapshots.slice(1).map((s) => {
          const isActive = s.turnNumber === currentTurn;
          const isWhite = s.activePlayer === PlayerSide.WHITE;
          const move = s.lastMove;

          let desc = 'Pass';
          if (move) {
            desc = `Piece #${move.pieceId} -> (${move.to.x}, ${move.to.y})`;
          }

          return (
            <div
              key={s.turnNumber}
              data-active={isActive ? 'true' : 'false'}
              onClick={() => onSelectTurn(s.turnNumber)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 12px',
                borderRadius: '6px',
                backgroundColor: isActive ? '#1e293b' : 'transparent',
                border: isActive ? '1px solid #38bdf8' : '1px solid transparent',
                cursor: 'pointer',
                fontSize: '12px',
                fontFamily: "'JetBrains Mono', monospace",
                transition: 'background-color 0.15s ease',
              }}
              onMouseEnter={(e) => {
                if (!isActive) e.currentTarget.style.backgroundColor = '#141d2d';
              }}
              onMouseLeave={(e) => {
                if (!isActive) e.currentTarget.style.backgroundColor = 'transparent';
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ color: '#64748b', minWidth: '36px' }}>
                  #{String(s.turnNumber).padStart(2, '0')}
                </span>
                <span style={{
                  color: isWhite ? '#38bdf8' : '#f43f5e',
                  fontWeight: 700,
                  minWidth: '50px',
                }}>
                  {isWhite ? 'WHITE' : 'BLACK'}
                </span>
                <span style={{ color: '#f1f5f9' }}>{desc}</span>
              </div>

              {move?.isCapture && (
                <span style={{
                  backgroundColor: 'rgba(239, 68, 68, 0.2)',
                  color: '#ef4444',
                  border: '1px solid #ef4444',
                  borderRadius: '4px',
                  padding: '2px 6px',
                  fontSize: '10px',
                  fontWeight: 800,
                }}>
                  KILL
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
