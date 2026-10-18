import React from 'react';
import { Badge } from './Badge.js';

export interface StandingsRow {
  readonly rank: number;
  readonly teamId: string;
  readonly teamName: string;
  readonly points: number;
  readonly matchesPlayed: number;
  readonly wins: number;
  readonly draws: number;
  readonly losses: number;
  readonly buchholz?: number;
  readonly ratingElo?: number;
  readonly isQualified?: boolean;
}

export interface StandingsTableProps {
  readonly standings: readonly StandingsRow[];
  readonly myTeamId?: string;
  readonly isProvisional?: boolean;
}

export const StandingsTable: React.FC<StandingsTableProps> = ({
  standings,
  myTeamId,
  isProvisional = false,
}) => {
  return (
    <div
      style={{
        backgroundColor: 'var(--surface)',
        border: '1px solid var(--border-subtle)',
        borderRadius: '8px',
        overflowX: 'auto',
      }}
    >
      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          textAlign: 'left',
          fontSize: '14px',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        <thead>
          <tr
            style={{
              backgroundColor: 'var(--surface-subtle)',
              borderBottom: '1px solid var(--border-subtle)',
              color: 'var(--text-secondary)',
              fontSize: '12px',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            <th style={{ padding: '12px 16px', width: '60px' }}>Rank</th>
            <th style={{ padding: '12px 16px' }}>Team</th>
            <th style={{ padding: '12px 16px', textAlign: 'center' }}>Played</th>
            <th style={{ padding: '12px 16px', textAlign: 'center' }}>W - D - L</th>
            <th style={{ padding: '12px 16px', textAlign: 'center' }}>Points</th>
            {standings[0]?.buchholz !== undefined && (
              <th style={{ padding: '12px 16px', textAlign: 'center' }}>Buchholz</th>
            )}
            {standings[0]?.ratingElo !== undefined && (
              <th style={{ padding: '12px 16px', textAlign: 'center' }}>Elo</th>
            )}
            <th style={{ padding: '12px 16px', textAlign: 'center' }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {standings.length === 0 ? (
            <tr>
              <td
                colSpan={8}
                style={{
                  padding: '32px',
                  textAlign: 'center',
                  color: 'var(--text-secondary)',
                }}
              >
                Chưa có dữ liệu xếp hạng
              </td>
            </tr>
          ) : (
            standings.map((row) => {
              const isMe = row.teamId === myTeamId;
              return (
                <tr
                  key={row.teamId}
                  style={{
                    borderBottom: '1px solid var(--border-subtle)',
                    backgroundColor: isMe ? 'rgba(196, 181, 253, 0.08)' : 'transparent',
                    borderLeft: isMe ? '3px solid var(--action)' : '3px solid transparent',
                  }}
                >
                  <td
                    style={{
                      padding: '14px 16px',
                      fontWeight: 700,
                      color: row.rank <= 3 ? 'var(--action)' : 'var(--text-primary)',
                    }}
                  >
                    #{row.rank}
                  </td>
                  <td style={{ padding: '14px 16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                        {row.teamName}
                      </span>
                      {isMe && <Badge variant="info">Đội của bạn</Badge>}
                    </div>
                  </td>
                  <td style={{ padding: '14px 16px', textAlign: 'center' }}>
                    {row.matchesPlayed}
                  </td>
                  <td
                    style={{
                      padding: '14px 16px',
                      textAlign: 'center',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    {row.wins} - {row.draws} - {row.losses}
                  </td>
                  <td
                    style={{
                      padding: '14px 16px',
                      textAlign: 'center',
                      fontWeight: 700,
                      color: 'var(--text-primary)',
                    }}
                  >
                    {row.points}
                  </td>
                  {row.buchholz !== undefined && (
                    <td style={{ padding: '14px 16px', textAlign: 'center' }}>
                      {row.buchholz.toFixed(1)}
                    </td>
                  )}
                  {row.ratingElo !== undefined && (
                    <td
                      style={{
                        padding: '14px 16px',
                        textAlign: 'center',
                        fontWeight: 600,
                        color: 'var(--accent-secondary)',
                      }}
                    >
                      {Math.round(row.ratingElo)}
                    </td>
                  )}
                  <td style={{ padding: '14px 16px', textAlign: 'center' }}>
                    {row.isQualified ? (
                      <Badge variant="success">QUALIFIED</Badge>
                    ) : isProvisional ? (
                      <Badge variant="warning">PROVISIONAL</Badge>
                    ) : (
                      <Badge variant="neutral">ACTIVE</Badge>
                    )}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
};
