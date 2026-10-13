import React from 'react';
import { Trophy, Swords, RefreshCw, Flame, Calendar, Play, ChevronRight, ChevronDown, Plus } from 'lucide-react';
import {
  fetchTournaments,
  fetchTournamentDetails,
  TournamentSummary,
  TournamentDetailsResponse,
  fetchOwnedBots, BotSummary, submitTournamentEntry, lockTournamentRegistration, projectTournamentNextMatch,
} from '../api/client.js';
import { ChampionOverlay } from './ChampionOverlay.js';
import { useSession } from '../session.js';

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
  readonly onPlayMatch: (matchId: string) => Promise<void>;
  readonly initialTournamentId?: string;
}

export const LeaderboardView: React.FC<LeaderboardViewProps> = ({
  onChallengeBot,
  onOpenCreateTournament,
  onPlayMatch,
  initialTournamentId,
}) => {
  const {user}=useSession();
  const [ownedBots,setOwnedBots]=React.useState<BotSummary[]>([]);
  const [entryBotId,setEntryBotId]=React.useState('');
  React.useEffect(()=>{if(user)fetchOwnedBots().then(setOwnedBots);else setOwnedBots([]);},[user?.id]);
  const [activeTab, setActiveTab] = React.useState<'LADDER' | 'TOURNAMENTS'>(initialTournamentId ? 'TOURNAMENTS' : 'LADDER');
  const [entries, setEntries] = React.useState<LeaderboardEntry[]>([]);
  const [tournaments, setTournaments] = React.useState<TournamentSummary[]>([]);
  const [selectedTourId, setSelectedTourId] = React.useState<string | null>(null);
  const [tourDetails, setTourDetails] = React.useState<TournamentDetailsResponse | null>(null);
  const [isLoading, setIsLoading] = React.useState<boolean>(false);
  const [projectedByTournament, setProjectedByTournament] = React.useState<Record<string, number>>({});
  const serverProjectedIndex = React.useMemo(() => {
    try {
      return tourDetails ? JSON.parse(tourDetails.tournament.config_json || '{}').projectedIndex ?? 0 : 0;
    } catch { return 0; }
  }, [tourDetails]);
  const projectedMatchIndex = selectedTourId && projectedByTournament[selectedTourId] !== undefined
    ? projectedByTournament[selectedTourId]
    : serverProjectedIndex;
  const [projecting, setProjecting] = React.useState(false);
  const [projectionError, setProjectionError] = React.useState<string | null>(null);
  const [showChampionCeremony, setShowChampionCeremony] = React.useState<boolean>(false);

  const fetchData = React.useCallback(() => {
    setIsLoading(true);
    if (selectedTourId) {
      fetchTournamentDetails(selectedTourId).then(setTourDetails).catch(console.error);
    }
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
  }, [selectedTourId]);

  React.useEffect(() => {
    fetchData();
  }, [fetchData]);

  React.useEffect(() => {
    if (initialTournamentId) {
      fetchData();
      setActiveTab('TOURNAMENTS');
      setSelectedTourId(initialTournamentId);
      fetchTournamentDetails(initialTournamentId)
        .then((data) => setTourDetails(data))
        .catch((err) => console.error('Failed to load tournament details:', err));
    }
  }, [initialTournamentId]);

  const handleSelectTournament = (id: string) => {
    if (selectedTourId === id) {
      setSelectedTourId(null);
      setTourDetails(null);
      return;
    }

    setSelectedTourId(id);
    setTourDetails(null);
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
          {activeTab === 'TOURNAMENTS' && user?.role === 'ADMIN' && (
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
                      {tourDetails.tournament.status==='PENDING' && JSON.parse(tourDetails.tournament.config_json).registrationOpen && (
                        <section style={{border:'1px solid #06b6d4',padding:12,borderRadius:8}}>
                          <h3>Đăng ký tham gia giải</h3>
                          <p>{JSON.parse(tourDetails.tournament.config_json).botIds.length} người đã nộp bot. Mỗi tài khoản một bài nộp.</p>
                          <select aria-label="Bot tham gia giải" value={entryBotId} onChange={event=>setEntryBotId(event.target.value)} style={{width:'100%',padding:8}}>
                            <option value="">Chọn bot của bạn</option>{ownedBots.map(bot=><option key={bot.id} value={bot.id}>{bot.name} · v{bot.version}</option>)}
                          </select>
                          <button disabled={!user||!entryBotId||projecting} onClick={async()=>{setProjecting(true);try{setTourDetails(await submitTournamentEntry(t.id,entryBotId));}catch(error){setProjectionError(error instanceof Error?error.message:'Submission failed');}finally{setProjecting(false);}}}>Nộp bot tham gia</button>
                          {user?.role === 'ADMIN' && <button disabled={projecting} onClick={async()=>{setProjecting(true);try{setTourDetails(await lockTournamentRegistration(t.id));fetchData();}catch(error){setProjectionError(error instanceof Error?error.message:'Cannot lock roster');}finally{setProjecting(false);}}}>Chốt danh sách & ghép cặp</button>}
                        </section>
                      )}
                      {/* Operator Broadcast Control Deck */}
                      {user?.role === 'ADMIN' && (
                      <div style={{
                        backgroundColor: '#0b111e',
                        border: '1px solid #eab308',
                        borderRadius: '8px',
                        padding: '10px 12px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '8px',
                        boxShadow: '0 0 15px rgba(234, 179, 8, 0.15)',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span style={{
                              width: '8px',
                              height: '8px',
                              borderRadius: '50%',
                              backgroundColor: '#eab308',
                              boxShadow: '0 0 8px #eab308',
                            }} />
                            <span style={{ fontSize: '11px', fontWeight: 800, color: '#f8fafc' }}>
                              ĐIỀU PHỐI TRÌNH CHIẾU GIẢI ĐẤU
                            </span>
                          </div>
                          <span style={{ fontSize: '11px', color: '#eab308', fontWeight: 700 }}>
                            {projectedMatchIndex < tourDetails.matches.length
                              ? `Trận ${projectedMatchIndex + 1} / ${tourDetails.matches.length}`
                              : 'Đã chiếu hết các trận'}
                          </span>
                        {projectionError && <p role="alert" style={{color:'#fca5a5'}}>{projectionError}</p>}
                        </div>

                        <div style={{ display: 'flex', gap: '8px' }}>
                          <button
                            onClick={async () => {
                              if (!tourDetails || projecting || projectedMatchIndex >= tourDetails.matches.length) return;
                              const tournamentId = tourDetails.tournament.id;
                              setProjecting(true);
                              setProjectionError(null);
                              try {
                                await onPlayMatch(tourDetails.matches[projectedMatchIndex].id);
                                await projectTournamentNextMatch(tournamentId);
                                setProjectedByTournament(previous => ({...previous, [tournamentId]: projectedMatchIndex + 1}));
                              } catch (error) {
                                setProjectionError(error instanceof Error ? error.message : 'Unable to project match');
                              } finally { setProjecting(false); }
                            }}
                            disabled={projecting || projectedMatchIndex >= tourDetails.matches.length}
                            style={{
                              flex: 1,
                              backgroundColor: '#eab308',
                              color: '#0f172a',
                              border: 'none',
                              borderRadius: '6px',
                              padding: '8px 12px',
                              fontWeight: 800,
                              fontSize: '12px',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              gap: '6px',
                              boxShadow: '0 2px 10px rgba(234, 179, 8, 0.4)',
                            }}
                          >
                            <Play size={14} fill="#0f172a" />
                            <span>Trận đấu tiếp theo (Next Match)</span>
                          </button>

                          {isCompleted && projectedMatchIndex >= tourDetails.matches.length && tourDetails.standings.length > 0 && (
                            <button
                              onClick={() => setShowChampionCeremony(true)}
                              style={{
                                backgroundColor: '#0284c7',
                                color: '#ffffff',
                                border: 'none',
                                borderRadius: '6px',
                                padding: '8px 12px',
                                fontWeight: 800,
                                fontSize: '12px',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '6px',
                              }}
                            >
                              <Trophy size={14} />
                              <span>Vinh Danh Quán Quân</span>
                            </button>
                          )}
                        </div>
                      </div>
                      )}

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
      {showChampionCeremony && tourDetails && tourDetails.standings.length > 0 && (
        <ChampionOverlay
          tournamentName={tourDetails.tournament.name}
          champion={tourDetails.standings[0]}
          runnerUp={tourDetails.standings[1]}
          thirdPlace={tourDetails.standings[2]}
          onDismiss={() => setShowChampionCeremony(false)}
        />
      )}
    </div>
  );
};
