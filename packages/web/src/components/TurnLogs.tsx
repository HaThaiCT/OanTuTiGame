import React from 'react';
import { PlayerSide, PieceType } from '@oantuti/engine';
import { RotateCcw, Clock, ScrollText } from 'lucide-react';
import { ReplayTurnSnapshot } from '../replay/player.js';

interface TurnLogsProps {
  readonly snapshots: readonly ReplayTurnSnapshot[];
  readonly currentTurn: number;
  readonly onSelectTurn: (turn: number) => void;
  readonly onClearLogs?: () => void;
}

export const TurnLogs: React.FC<TurnLogsProps> = ({
  snapshots,
  currentTurn,
  onSelectTurn,
  onClearLogs,
}) => {
  const listRef = React.useRef<HTMLDivElement>(null);

  // Progressive logs: only show turns from 1 up to currentTurn
  const visibleSnapshots = React.useMemo(() => {
    if (currentTurn <= 0) return [];
    return snapshots.slice(1, currentTurn + 1);
  }, [snapshots, currentTurn]);

  // Auto-scroll to bottom as new turns appear
  React.useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [visibleSnapshots.length, currentTurn]);

  const handleResetToStart = () => {
    onSelectTurn(0);
    onClearLogs?.();
  };

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
      {/* Header with turn count and Clear/Restart button */}
      <div style={{
        padding: '10px 14px',
        borderBottom: '1px solid #1e293b',
        fontWeight: 700,
        fontSize: '12px',
        color: '#94a3b8',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        backgroundColor: '#141d2d',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <ScrollText size={14} color="#38bdf8" />
          <span>MATCH TURN LOGS</span>
          <span style={{
            fontSize: '11px',
            backgroundColor: '#0f172a',
            color: '#38bdf8',
            padding: '2px 6px',
            borderRadius: '10px',
            fontWeight: 800,
          }}>
            {visibleSnapshots.length} / {Math.max(0, snapshots.length - 1)}
          </span>
        </div>

        {visibleSnapshots.length > 0 && (
          <button
            onClick={handleResetToStart}
            title="Clear logs & reset to Turn 0"
            style={{
              background: 'none',
              border: 'none',
              color: '#64748b',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              fontSize: '11px',
              fontWeight: 600,
              padding: '2px 6px',
              borderRadius: '4px',
              transition: 'color 0.15s ease',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = '#ef4444')}
            onMouseLeave={(e) => (e.currentTarget.style.color = '#64748b')}
          >
            <RotateCcw size={12} />
            <span>Reset Logs</span>
          </button>
        )}
      </div>

      {/* Log items container */}
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
        {visibleSnapshots.length === 0 ? (
          <div style={{
            padding: '36px 16px',
            textAlign: 'center',
            color: '#64748b',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
          }}>
            <Clock size={28} color="#475569" />
            <div style={{ fontSize: '13px', fontWeight: 600, color: '#94a3b8' }}>
              Chưa có lượt đi nào phát sinh
            </div>
            <div style={{ fontSize: '11px', color: '#64748b', maxWidth: '240px', lineHeight: 1.4 }}>
              Nhật ký sẽ xuất hiện dần dần theo từng lượt đi của trận đấu khi bạn ấn Chạy hoặc Play...
            </div>
          </div>
        ) : (
          visibleSnapshots.map((s) => {
            const isActive = s.turnNumber === currentTurn;
            const isWhite = s.activePlayer === PlayerSide.WHITE;
            const move = s.lastMove;
            const mover = move ? s.pieces.find((p) => p.id === move.pieceId) : undefined;

            return (
              <div
                key={s.turnNumber}
                data-active={isActive ? 'true' : 'false'}
                onClick={() => onSelectTurn(s.turnNumber)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '7px 10px',
                  borderRadius: '6px',
                  backgroundColor: isActive ? 'rgba(56, 189, 248, 0.12)' : '#141d2d',
                  border: isActive ? '1px solid #38bdf8' : '1px solid transparent',
                  cursor: 'pointer',
                  fontSize: '12px',
                  fontFamily: "'JetBrains Mono', monospace",
                  transition: 'background-color 0.15s ease',
                  animation: 'fadeIn 0.25s ease-in-out',
                }}
                onMouseEnter={(e) => {
                  if (!isActive) e.currentTarget.style.backgroundColor = '#1e293b';
                }}
                onMouseLeave={(e) => {
                  if (!isActive) e.currentTarget.style.backgroundColor = '#141d2d';
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ color: '#64748b', minWidth: '32px', fontSize: '11px' }}>
                    #{String(s.turnNumber).padStart(2, '0')}
                  </span>
                  <span style={{
                    color: isWhite ? '#38bdf8' : '#f43f5e',
                    fontWeight: 800,
                    minWidth: '46px',
                    fontSize: '11px',
                  }}>
                    {isWhite ? 'WHITE' : 'BLACK'}
                  </span>
                  {move && mover ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', color: '#f1f5f9' }}>
                      <span style={{ fontSize: '13px' }}>
                        {mover.type === PieceType.ROCK ? '✊' : mover.type === PieceType.SCISSORS ? '✌️' : '✋'}
                      </span>
                      <span>#{move.pieceId} → ({move.to.x}, {move.to.y})</span>
                    </span>
                  ) : (
                    <span style={{ color: '#64748b' }}>PASS</span>
                  )}
                </div>

                {move?.isCapture && (
                  <span style={{
                    backgroundColor: 'rgba(239, 68, 68, 0.2)',
                    color: '#ef4444',
                    border: '1px solid #ef4444',
                    borderRadius: '4px',
                    padding: '2px 5px',
                    fontSize: '10px',
                    fontWeight: 800,
                  }}>
                    KILL
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
