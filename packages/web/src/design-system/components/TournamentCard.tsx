import React from 'react';
import { Card, CardContent } from './Card.js';
import { Badge } from './Badge.js';
import { Button } from './Button.js';

export interface TournamentCardProps {
  readonly id: string;
  readonly name: string;
  readonly format: 'SINGLE_ELIMINATION' | 'SWISS_PLAYOFF' | 'ROUND_ROBIN' | 'ELO_ARENA';
  readonly state: 'DRAFT' | 'REGISTRATION_OPEN' | 'VALIDATING_SUBMISSIONS' | 'LOCKED' | 'READY_TO_START' | 'RUNNING' | 'PROVISIONAL' | 'FINALIZED' | 'ARCHIVED';
  readonly registeredTeamsCount?: number;
  readonly maxTeams?: number;
  readonly onSelect?: (id: string) => void;
}

export const TournamentCard: React.FC<TournamentCardProps> = ({
  id,
  name,
  format,
  state,
  registeredTeamsCount = 0,
  maxTeams = 500,
  onSelect,
}) => {
  const formatLabels: Record<string, string> = {
    SINGLE_ELIMINATION: 'Single Elimination',
    SWISS_PLAYOFF: 'Swiss -> Playoff',
    ROUND_ROBIN: 'Round Robin',
    ELO_ARENA: 'Elo Arena',
  };

  const stateBadges: Record<string, { label: string; variant: 'live' | 'success' | 'warning' | 'info' | 'neutral' }> = {
    DRAFT: { label: 'Bản nháp', variant: 'neutral' },
    REGISTRATION_OPEN: { label: 'Đang mở đăng ký', variant: 'info' },
    VALIDATING_SUBMISSIONS: { label: 'Đang kiểm tra bài nộp', variant: 'warning' },
    LOCKED: { label: 'Đã chốt danh sách', variant: 'warning' },
    READY_TO_START: { label: 'Chờ bắt đầu', variant: 'warning' },
    RUNNING: { label: 'Đang diễn ra', variant: 'live' },
    PROVISIONAL: { label: 'Kết quả tạm tính', variant: 'warning' },
    FINALIZED: { label: 'Đã hoàn tất', variant: 'success' },
    ARCHIVED: { label: 'Đã lưu trữ', variant: 'neutral' },
  };

  const currentBadge = stateBadges[state] ?? { label: state, variant: 'neutral' };

  return (
    <Card
      style={{
        transition: 'transform 120ms ease-out, border-color 120ms ease-out',
        cursor: onSelect ? 'pointer' : 'default',
      }}
      onClick={() => onSelect?.(id)}
    >
      <CardContent style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
          <div>
            <span style={{ fontSize: '12px', color: 'var(--accent-secondary)', fontWeight: 600 }}>
              {formatLabels[format] ?? format}
            </span>
            <h4 style={{ margin: '4px 0 0 0', fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)' }}>
              {name}
            </h4>
          </div>
          <Badge variant={currentBadge.variant}>{currentBadge.label}</Badge>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '13px', color: 'var(--text-secondary)' }}>
          <span>
            Đội thi: <strong>{registeredTeamsCount}</strong>/{maxTeams}
          </span>
          <Button variant="secondary" size="sm" onClick={(e) => { e.stopPropagation(); onSelect?.(id); }}>
            Xem giải đấu →
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};
