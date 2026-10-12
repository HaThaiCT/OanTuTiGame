import React from 'react';
import { Trophy, Swords, RefreshCw, Flame, Calendar, Play, ChevronRight, ChevronDown, Plus } from 'lucide-react';
import {
  fetchTournaments,
  fetchTournamentDetails,
  TournamentSummary,
  TournamentDetailsResponse,
} from '../api/client.js';

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
  readonly onOpenCreateTournament: () => void;
  readonly onPlayMatch: (matchId: string) => void;
}

export const LeaderboardView: React.FC<LeaderboardViewProps> = ({
  onChallengeBot,
  onOpenCreateTournament,
  onPlayMatch,
}) => {
  const [activeTab, setActiveTab] = React.useState<'LADDER' | 'TOURNAMENTS'>('LADDER');
  const [entries, setEntries] = React.useState<LeaderboardEntry[]>([]);
  const [tournaments, setTournaments] = React.useState<TournamentSummary[]>([]);
  const [selectedTourId, setSelectedTourId] = React.useState<string | null>(null);
  const [tourDetails, setTourDetails] = React.useState<TournamentDetailsResponse | null>(null);
  const [isLoading, setIsLoading] = React.useState<boolean>(false);

  const fetchData = React.useCallback(() => {
    setIsLoading(true);
    Promise.all([
      fetch('/api/leaderboard').then((res) => res.json()),
      fetchTournaments().catch(() => []),
    ])
      .then(([lbData, tourList]) => {
        setEntries(lbData.leaderboard || []);
        setTournaments(tourList);
      })
      .catch((err) => console.error('Failed to load leaderboard/tournaments:', err))
      .finally(() => setIsLoading(false));
  }, []);

  React.useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSelectTournament = (id: string) => {
    if (selectedTourId === id) {
      setSelectedTourId(null);
      setTourDetails(null);
      return;
    }

    setSelectedTourId(id);
    fetchTournamentDetails(id)
      .then((data) => setTourDetails(data))
      .catch((err) => console.error('Failed to load tournament details:', err));
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
      {/* Top Header & Subtabs */}
      <div style={{
        padding: '10px 14px',
        borderBottom: '1px solid #1e293b',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: '#141d2d',
      }}>
        {/* Sub-tab toggle */}
        <div style={{ display: 'flex', backgroundColor: '#0f172a', borderRadius: '6px', padding: '2px', border: '1px solid #334155' }}>
          <button
            onClick={() => setActiveTab('LADDER')}
            style={{
              backgroundColor: activeTab === 'LADDER' ? '#0284c7' : 'transparent',
              color: activeTab === 'LADDER' ? '#ffffff' : '#94a3b8',
              border: 'none',
              borderRadius: '4px',
              padding: '4px 10px',
              fontSize: '11px',
              fontWeight: 700,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            <Flame size={12} />
            <span>ELO Ladder</span>
          </button>

          <button
            onClick={() => setActiveTab('TOURNAMENTS')}
            style={{
              backgroundColor: activeTab === 'TOURNAMENTS' ? '#eab308' : 'transparent',
              color: activeTab === 'TOURNAMENTS' ? '#0f172a' : '#94a3b8',
              border: 'none',
              borderRadius: '4px',
              padding: '4px 10px',
              fontSize: '11px',
              fontWeight: 800,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            <Trophy size={12} />
            <span>Tournaments</span>
          </button>
        </div>

        {/* Action button */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {activeTab === 'TOURNAMENTS' && (
            <button
              onClick={onOpenCreateTournament}
              style={{
                backgroundColor: '#eab308',
                color: '#0f172a',
                border: 'none',
                borderRadius: '6px',
                padding: '4px 10px',
                fontSize: '11px',
                fontWeight: 800,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
              }}
            >
              <Plus size={13} />
              <span>Create</span>
            </button>
          )}

          <button
            onClick={fetchData}
            disabled={isLoading}
            style={{
              background: 'none',
              border: 'none',
              color: '#64748b',
              cursor: 'pointer',
              padding: '4px',
            }}
            title="Refresh data"
          >
            <RefreshCw size={13} className={isLoading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Tab 1: ELO Standings */}
      {activeTab === 'LADDER' && (
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
                        backgroundColor: '#0f172a',
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
      )}

      {/* Tab 2: Tournaments List & Details */}
      {activeTab === 'TOURNAMENTS' && (
        <div style={{
          flex: 1,
          overflowY: 'auto',
          padding: '10px',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
        }}>
          {tournaments.length === 0 ? (
            <div style={{ padding: '36px 16px', textAlign: 'center', color: '#64748b' }}>
              <Trophy size={28} color="#475569" style={{ margin: '0 auto 8px' }} />
              <div style={{ fontWeight: 700, color: '#94a3b8' }}>Chưa có giải đấu nào</div>
              <div style={{ fontSize: '11px', marginTop: '4px' }}>
                Bấm nút "Create" ở trên để khởi tạo giải đấu Round-Robin tự động!
              </div>
            </div>
          ) : (
            tournaments.map((t) => {
              const isSelected = selectedTourId === t.id;
              const isCompleted = t.status === 'COMPLETED';

              return (
                <div
                  key={t.id}
                  style={{
                    backgroundColor: '#141d2d',
                    borderRadius: '8px',
                    border: isSelected ? '1px solid #eab308' : '1px solid #1e293b',
                    overflow: 'hidden',
                  }}
                >
                  {/* Tournament Row Header */}
                  <div
                    onClick={() => handleSelectTournament(t.id)}
                    style={{
                      padding: '10px 12px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      backgroundColor: isSelected ? '#1e293b' : 'transparent',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {isSelected ? <ChevronDown size={16} color="#eab308" /> : <ChevronRight size={16} color="#64748b" />}
                      <div>
                        <div style={{ fontWeight: 800, fontSize: '13px', color: '#f1f5f9' }}>
                          {t.name}
                        </div>
                        <div style={{ fontSize: '10px', color: '#64748b', marginTop: '2px' }}>
                          {t.format} • {t.created_at}
                        </div>
                      </div>
                    </div>

                    <span style={{
                      fontSize: '10px',
                      fontWeight: 800,
                      padding: '2px 8px',
                      borderRadius: '12px',
                      backgroundColor: isCompleted ? 'rgba(34, 197, 94, 0.2)' : 'rgba(234, 179, 8, 0.2)',
                      color: isCompleted ? '#4ade80' : '#facc15',
                      border: isCompleted ? '1px solid #22c55e' : '1px solid #eab308',
                    }}>
                      {t.status}
                    </span>
                  </div>

                  {/* Expanded Tournament Details (Standings & Fixtures) */}
                  {isSelected && tourDetails && (
                    <div style={{ padding: '12px', borderTop: '1px solid #1e293b', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                      {/* Standings Table */}
                      <div>
                        <div style={{ fontSize: '11px', fontWeight: 800, color: '#eab308', marginBottom: '6px', textTransform: 'uppercase' }}>
                          🏆 Standings Table
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                          {tourDetails.standings.map((s, idx) => (
                            <div
                              key={s.botId}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                padding: '4px 8px',
                                borderRadius: '4px',
                                backgroundColor: idx === 0 ? 'rgba(234, 179, 8, 0.12)' : '#0f172a',
                                fontSize: '11px',
                              }}
                            >
                              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <span style={{ fontWeight: 900, color: idx === 0 ? '#eab308' : '#64748b', width: '16px' }}>
                                  #{idx + 1}
                                </span>
                                <span style={{ fontWeight: 700, color: '#f8fafc' }}>{s.botName}</span>
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <span style={{ color: '#94a3b8' }}>{s.wins}W - {s.losses}L</span>
                                <span style={{ fontWeight: 800, color: '#38bdf8' }}>{s.points} pts</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Matches Fixtures */}
                      <div>
                        <div style={{ fontSize: '11px', fontWeight: 800, color: '#94a3b8', marginBottom: '6px', textTransform: 'uppercase' }}>
                          ⚔️ Match Fixtures ({tourDetails.matches.length})
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '140px', overflowY: 'auto' }}>
                          {tourDetails.matches.map((m) => (
                            <div
                              key={m.id}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                padding: '6px 8px',
                                borderRadius: '4px',
                                backgroundColor: '#0f172a',
                                border: '1px solid #1e293b',
                                fontSize: '11px',
                              }}
                            >
                              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <span style={{ color: '#38bdf8', fontWeight: 700 }}>{m.white_bot_name}</span>
                                <span style={{ color: '#64748b' }}>vs</span>
                                <span style={{ color: '#f43f5e', fontWeight: 700 }}>{m.black_bot_name}</span>
                              </div>

                              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <span style={{ fontSize: '10px', color: m.winner_side ? '#4ade80' : '#eab308' }}>
                                  {m.winner_side ? `${m.winner_side} (${m.total_turns}T)` : 'Pending'}
                                </span>

                                <button
                                  onClick={() => onPlayMatch(m.id)}
                                  title="Watch Replay in Visualizer"
                                  style={{
                                    backgroundColor: '#1e293b',
                                    color: '#38bdf8',
                                    border: '1px solid #334155',
                                    borderRadius: '4px',
                                    padding: '3px 6px',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '3px',
                                    fontSize: '10px',
                                    fontWeight: 700,
                                  }}
                                >
                                  <Play size={10} />
                                  <span>View</span>
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
};
