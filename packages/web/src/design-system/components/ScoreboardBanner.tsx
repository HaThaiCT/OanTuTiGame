import React from 'react';
import { Badge } from './Badge.js';

export interface ScoreboardBannerProps {
  readonly teamAName: string;
  readonly teamBName: string;
  readonly scoreA: number;
  readonly scoreB: number;
  readonly status: 'LIVE' | 'PROVISIONAL' | 'FINAL' | 'PENDING';
  readonly mapName?: string;
  readonly roundInfo?: string;
  readonly currentTurn?: number;
  readonly maxTurns?: number;
}

export const ScoreboardBanner: React.FC<ScoreboardBannerProps> = ({
  teamAName,
  teamBName,
  scoreA,
  scoreB,
  status,
  mapName,
  roundInfo,
  currentTurn,
  maxTurns,
}) => {
  return (
    <div
      style={{
        backgroundColor: 'var(--surface)',
        borderBottom: '1px solid var(--border-subtle)',
        padding: '16px 24px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '24px',
      }}
    >
      {/* Left Team (White) */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '16px' }}>
        <div
          style={{
            width: '12px',
            height: '12px',
            borderRadius: '50%',
            backgroundColor: 'var(--text-primary)',
            border: '2px solid var(--action)',
          }}
          title="White Side"
        />
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)' }}>
            {teamAName}
          </span>
          <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Side A (White)</span>
        </div>
      </div>

      {/* Center Match Score & Status */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '6px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {status === 'LIVE' && <Badge variant="live">LIVE</Badge>}
          {status === 'PROVISIONAL' && <Badge variant="warning">PROVISIONAL</Badge>}
          {status === 'FINAL' && <Badge variant="success">FINAL</Badge>}
          {status === 'PENDING' && <Badge variant="neutral">UPCOMING</Badge>}
          {mapName && (
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              Map: <strong>{mapName}</strong>
            </span>
          )}
        </div>

        {/* Large Scoreboard */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '16px',
            fontSize: '36px',
            fontWeight: 800,
            fontVariantNumeric: 'tabular-nums',
            color: 'var(--text-primary)',
          }}
        >
          <span>{scoreA}</span>
          <span style={{ color: 'var(--border-control)', fontSize: '24px' }}>:</span>
          <span>{scoreB}</span>
        </div>

        {(currentTurn !== undefined || roundInfo) && (
          <span style={{ fontSize: '12px', color: 'var(--accent-secondary)', fontWeight: 500 }}>
            {roundInfo ? `${roundInfo} • ` : ''}
            {currentTurn !== undefined ? `Turn ${currentTurn}${maxTurns ? `/${maxTurns}` : ''}` : ''}
          </span>
        )}
      </div>

      {/* Right Team (Black) */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '16px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
          <span style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)' }}>
            {teamBName}
          </span>
          <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Side B (Black)</span>
        </div>
        <div
          style={{
            width: '12px',
            height: '12px',
            borderRadius: '50%',
            backgroundColor: '#111827',
            border: '2px solid var(--accent-secondary)',
          }}
          title="Black Side"
        />
      </div>
    </div>
  );
};
