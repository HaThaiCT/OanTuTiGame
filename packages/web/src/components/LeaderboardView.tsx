import React from 'react';
import { Trophy, Swords, RefreshCw, Flame } from 'lucide-react';

export interface LeaderboardEntry {
  readonly id: string;
  readonly bot_id: string;
  readonly bot_name: string;
  readonly language: string;
  readonly rating_elo: number;
  readonly matches_played: number;
  readonly wins: number;
  readonly losses: number;
  readonly draws: number;
  readonly peak_elo: number;
}

interface LeaderboardViewProps {
  readonly onChallengeBot: (botId: string) => void;
}

export const LeaderboardView: React.FC<LeaderboardViewProps> = ({ onChallengeBot }) => {
  const [entries, setEntries] = React.useState<LeaderboardEntry[]>([]);
  const [isLoading, setIsLoading] = React.useState<boolean>(false);

  const fetchLeaderboard = React.useCallback(() => {
    setIsLoading(true);
    fetch('/api/leaderboard')
      .then((res) => res.json())
      .then((data) => {
        setEntries(data.leaderboard || []);
      })
      .catch((err) => console.error('Failed to load leaderboard:', err))
      .finally(() => setIsLoading(false));
  }, []);

  React.useEffect(() => {
    fetchLeaderboard();
  }, [fetchLeaderboard]);

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
      {/* Header */}
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid #1e293b',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: '#141d2d',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Trophy size={16} color="#eab308" />
          <span style={{ fontWeight: 800, fontSize: '13px', color: '#f8fafc' }}>
            ELO LEADERBOARD
          </span>
        </div>

        <button
          onClick={fetchLeaderboard}
          disabled={isLoading}
          style={{
            background: 'none',
            border: 'none',
            color: '#64748b',
            cursor: 'pointer',
            padding: '4px',
            display: 'flex',
            alignItems: 'center',
          }}
          title="Refresh rankings"
        >
          <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Rankings List */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: '10px',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
      }}>
        {entries.map((b, idx) => {
          const rank = idx + 1;
          const winRate =
            b.matches_played > 0
              ? Math.round((b.wins / b.matches_played) * 100)
              : 0;

          return (
            <div
              key={b.id}
              style={{
                backgroundColor: '#141d2d',
                borderRadius: '8px',
                padding: '10px 12px',
                border: rank === 1 ? '1px solid #eab308' : '1px solid #1e293b',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '10px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{
                  fontSize: '13px',
                  fontWeight: 900,
                  color: rank === 1 ? '#eab308' : rank === 2 ? '#94a3b8' : rank === 3 ? '#b45309' : '#475569',
                  minWidth: '22px',
                }}>
                  #{rank}
                </span>

                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ fontWeight: 800, fontSize: '13px', color: '#f1f5f9' }}>
                      {b.bot_name}
                    </span>
                    <span style={{
                      fontSize: '10px',
                      backgroundColor: '#1e293b',
                      color: '#94a3b8',
                      padding: '1px 5px',
                      borderRadius: '4px',
                      fontWeight: 700,
                    }}>
                      {b.language}
                    </span>
                  </div>

                  <div style={{ fontSize: '11px', color: '#64748b', marginTop: '2px' }}>
                    {b.wins}W • {b.losses}L • {b.draws}D ({winRate}% Win)
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'flex-end' }}>
                    <Flame size={13} color="#f59e0b" />
                    <span style={{ fontWeight: 800, fontSize: '14px', color: '#38bdf8' }}>
                      {b.rating_elo}
                    </span>
                  </div>
                  <div style={{ fontSize: '10px', color: '#64748b' }}>
                    Peak: {b.peak_elo}
                  </div>
                </div>

                <button
                  onClick={() => onChallengeBot(b.bot_id)}
                  title={`Challenge ${b.bot_name}`}
                  style={{
                    backgroundColor: '#1e293b',
                    color: '#e2e8f0',
                    border: '1px solid #334155',
                    borderRadius: '6px',
                    padding: '6px 8px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    fontSize: '11px',
                    fontWeight: 700,
                  }}
                >
                  <Swords size={12} color="#38bdf8" />
                  <span>Fight</span>
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
