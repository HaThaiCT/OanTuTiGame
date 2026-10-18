import React, { useState, useEffect } from 'react';
import { decodeValidTilesBitmask } from '@oantuti/protocol';
import { CanvasViewport } from './components/CanvasViewport.js';
import { Timeline } from './components/Timeline.js';
import { LoadedReplay, parseReplayBinary } from './replay/player.js';
import { generateDefaultMatch } from './replay/mock-generator.js';
import { themeTokens } from './design-system/tokens.js';
import './design-system/tokens.css';
import { ScoreboardBanner } from './design-system/components/ScoreboardBanner.js';
import { TournamentCard } from './design-system/components/TournamentCard.js';
import { StandingsTable, type StandingsRow } from './design-system/components/StandingsTable.js';
import { MultiFileEditor } from './design-system/components/MultiFileEditor.js';
import { MapEditor } from './design-system/components/MapEditor.js';
import { Badge } from './design-system/components/Badge.js';
import { Button } from './design-system/components/Button.js';
import { Card, CardHeader, CardTitle, CardContent } from './design-system/components/Card.js';
import { api } from './api/v2-client.js';

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

type ActiveView = 'TOURNAMENTS' | 'MATCHROOM' | 'WORKSPACE' | 'ORGANIZER';

export const App: React.FC = () => {
  const [activeView, setActiveView] = useState<ActiveView>('TOURNAMENTS');
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  // Tournaments state
  const [tournaments, setTournaments] = useState<any[]>([]);
  const [selectedTournament, setSelectedTournament] = useState<any | null>(null);
  const [standings, setStandings] = useState<StandingsRow[]>([]);
  const [bracketEncounters, setBracketEncounters] = useState<any[]>([]);
  const [tourneyTab, setTourneyTab] = useState<'OVERVIEW' | 'STANDINGS' | 'BRACKET'>('OVERVIEW');

  // Matchroom Visualizer state
  const [replay, setReplay] = useState<LoadedReplay>(() => generateDefaultMatch());
  const [currentTurn, setCurrentTurn] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);

  // Load tournaments on startup
  useEffect(() => {
    api.listTournaments().then((res) => {
      if (res.success && res.data?.tournaments) {
        setTournaments(res.data.tournaments);
        if (res.data.tournaments.length > 0) {
          loadTournamentDetails(res.data.tournaments[0].id);
        }
      }
    });
  }, []);

  const loadTournamentDetails = async (tournamentId: string) => {
    const tRes = await api.getTournament(tournamentId);
    if (tRes.success && tRes.data) {
      setSelectedTournament(tRes.data);
    }
    const sRes = await fetch(`/api/v2/tournaments/${tournamentId}/standings`);
    if (sRes.ok) {
      const sData = await sRes.json();
      setStandings(sData.standings || []);
    }
    const bRes = await fetch(`/api/v2/tournaments/${tournamentId}/bracket`);
    if (bRes.ok) {
      const bData = await bRes.json();
      setBracketEncounters(bData.encounters || []);
    }
  };

  // Timeline playback loop
  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (isPlaying && currentTurn < replay.snapshots.length - 1) {
      timer = setTimeout(() => {
        setCurrentTurn((prev) => prev + 1);
      }, 600 / playbackSpeed);
    } else if (currentTurn >= replay.snapshots.length - 1) {
      setIsPlaying(false);
    }
    return () => clearTimeout(timer);
  }, [isPlaying, currentTurn, playbackSpeed, replay.snapshots.length]);

  const validTilesSet = React.useMemo(() => {
    return decodeValidTilesBitmask(
      replay.init.map.validTilesBitmask,
      replay.init.map.width,
      replay.init.map.height
    );
  }, [replay]);

  const currentSnapshot = replay.snapshots[currentTurn] || replay.snapshots[0];

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        width: '100vw',
        backgroundColor: 'var(--canvas)',
        color: 'var(--text-primary)',
        overflow: 'hidden',
      }}
    >
      {/* ============================================================ */}
      {/* 1. TOP GLOBAL NAVIGATION HEADER                              */}
      {/* ============================================================ */}
      <header
        style={{
          height: '64px',
          borderBottom: '1px solid var(--border-subtle)',
          backgroundColor: 'var(--surface)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 24px',
          zIndex: 100,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '32px' }}>
          {/* Logo & Branding */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer' }} onClick={() => setActiveView('TOURNAMENTS')}>
            <div
              style={{
                width: '36px',
                height: '36px',
                borderRadius: '8px',
                background: 'linear-gradient(135deg, var(--action), var(--accent-secondary))',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 900,
                color: '#0B0D17',
                fontSize: '18px',
              }}
            >
              ⚔
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: '18px', fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>
                OanTuTi Arena <span style={{ color: 'var(--action)', fontSize: '13px' }}>v2</span>
              </span>
              <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>University Esports Portal</span>
            </div>
          </div>

          {/* Navigation Links */}
          <nav style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Button
              variant={activeView === 'TOURNAMENTS' ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => setActiveView('TOURNAMENTS')}
            >
              🏆 Giải đấu (Tournaments)
            </Button>
            <Button
              variant={activeView === 'MATCHROOM' ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => setActiveView('MATCHROOM')}
            >
              ⚔️ Phòng đấu (Matchroom)
            </Button>
            <Button
              variant={activeView === 'WORKSPACE' ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => setActiveView('WORKSPACE')}
            >
              💻 Không gian Đội thi (IDE)
            </Button>
            <Button
              variant={activeView === 'ORGANIZER' ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => setActiveView('ORGANIZER')}
            >
              🛠️ Ban tổ chức (Organizer)
            </Button>
          </nav>
        </div>

        {/* Right Header Status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <Badge variant="live">LIVE ENGINE ONLINE</Badge>
          <div
            style={{
              padding: '6px 12px',
              backgroundColor: 'var(--surface-subtle)',
              borderRadius: '6px',
              fontSize: '13px',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border-subtle)',
            }}
          >
            👤 Admin Demo (<span style={{ color: 'var(--action)' }}>ADMIN</span>)
          </div>
        </div>
      </header>

      {/* ============================================================ */}
      {/* 2. MAIN APPLICATION CONTENT AREA                             */}
      {/* ============================================================ */}
      <main style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
        {/* VIEW 1: TOURNAMENTS PORTAL */}
        {activeView === 'TOURNAMENTS' && (
          <div style={{ padding: '32px', maxWidth: '1280px', margin: '0 auto', width: '100%', display: 'flex', flexDirection: 'column', gap: '32px' }}>
            {/* Esports Hero Banner */}
            <div
              style={{
                padding: '36px',
                borderRadius: '12px',
                background: 'linear-gradient(135deg, rgba(196, 181, 253, 0.12) 0%, rgba(103, 232, 249, 0.08) 100%)',
                border: '1px solid var(--border-subtle)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <Badge variant="live" style={{ marginBottom: '12px' }}>ĐẤU TRƯỜNG BOT ĐẠI HỌC 2026</Badge>
                <h1 style={{ fontSize: '32px', fontWeight: 800, margin: '8px 0', color: 'var(--text-primary)' }}>
                  OanTuTi Arena Championship
                </h1>
                <p style={{ color: 'var(--text-secondary)', fontSize: '15px', maxWidth: '640px', lineHeight: '24px', margin: 0 }}>
                  Nền tảng thi đấu thuật toán tự động dành cho 500 đội sinh viên. Tích hợp 4 thể thức chuẩn: Single Elimination, Swiss Playoff, Round Robin, và Elo Arena.
                </p>
              </div>
              <div style={{ display: 'flex', gap: '12px' }}>
                <Button variant="primary" onClick={() => setActiveView('WORKSPACE')}>
                  Vào IDE Nộp bài →
                </Button>
                <Button variant="secondary" onClick={() => setActiveView('MATCHROOM')}>
                  Xem trực tiếp ván đấu
                </Button>
              </div>
            </div>

            {/* Tournament Directory Section */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <h2 style={{ fontSize: '20px', fontWeight: 700, margin: 0 }}>Danh sách giải đấu</h2>
                <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{tournaments.length} giải đấu đã công bố</span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: '20px' }}>
                {tournaments.length === 0 ? (
                  <Card style={{ padding: '32px', textAlign: 'center', color: 'var(--text-secondary)' }}>
                    Đang nạp danh sách giải đấu từ PostgreSQL 16...
                  </Card>
                ) : (
                  tournaments.map((t) => (
                    <TournamentCard
                      key={t.id}
                      id={t.id}
                      name={t.name}
                      format={t.format}
                      state={t.state}
                      maxTeams={t.max_teams}
                      onSelect={(id) => {
                        loadTournamentDetails(id);
                      }}
                    />
                  ))
                )}
              </div>
            </div>

            {/* Selected Tournament Detail View */}
            {selectedTournament && (
              <Card>
                <CardHeader>
                  <div>
                    <span style={{ fontSize: '12px', color: 'var(--accent-secondary)', fontWeight: 600 }}>Chi tiết giải đấu</span>
                    <CardTitle style={{ marginTop: '4px' }}>{selectedTournament.name}</CardTitle>
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <Button variant={tourneyTab === 'OVERVIEW' ? 'primary' : 'ghost'} size="sm" onClick={() => setTourneyTab('OVERVIEW')}>
                      Tổng quan
                    </Button>
                    <Button variant={tourneyTab === 'STANDINGS' ? 'primary' : 'ghost'} size="sm" onClick={() => setTourneyTab('STANDINGS')}>
                      Bảng xếp hạng ({standings.length})
                    </Button>
                    <Button variant={tourneyTab === 'BRACKET' ? 'primary' : 'ghost'} size="sm" onClick={() => setTourneyTab('BRACKET')}>
                      Nhánh đấu / Cặp đấu ({bracketEncounters.length})
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  {tourneyTab === 'OVERVIEW' && (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '20px' }}>
                      <div style={{ padding: '16px', backgroundColor: 'var(--surface-subtle)', borderRadius: '8px' }}>
                        <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Thể thức</span>
                        <div style={{ fontSize: '16px', fontWeight: 700, marginTop: '4px' }}>{selectedTournament.format}</div>
                      </div>
                      <div style={{ padding: '16px', backgroundColor: 'var(--surface-subtle)', borderRadius: '8px' }}>
                        <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Trạng thái</span>
                        <div style={{ marginTop: '4px' }}><Badge variant="live">{selectedTournament.state}</Badge></div>
                      </div>
                      <div style={{ padding: '16px', backgroundColor: 'var(--surface-subtle)', borderRadius: '8px' }}>
                        <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Quy tắc & Phiên bản</span>
                        <div style={{ fontSize: '16px', fontWeight: 700, marginTop: '4px' }}>{selectedTournament.rulesRevision || 'ArenaGameplay/v2'}</div>
                      </div>
                      <div style={{ padding: '16px', backgroundColor: 'var(--surface-subtle)', borderRadius: '8px' }}>
                        <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Sức chứa tối đa</span>
                        <div style={{ fontSize: '16px', fontWeight: 700, marginTop: '4px' }}>{selectedTournament.maxTeams || 500} đội</div>
                      </div>
                    </div>
                  )}

                  {tourneyTab === 'STANDINGS' && (
                    <StandingsTable standings={standings} />
                  )}

                  {tourneyTab === 'BRACKET' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                      {bracketEncounters.length === 0 ? (
                        <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-secondary)' }}>
                          Chưa có cặp đấu nào được sinh ra cho vòng này.
                        </div>
                      ) : (
                        bracketEncounters.map((enc) => (
                          <div
                            key={enc.encounter_id}
                            style={{
                              padding: '16px',
                              backgroundColor: 'var(--surface-subtle)',
                              borderRadius: '8px',
                              border: '1px solid var(--border-subtle)',
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                              <Badge variant="neutral">R{enc.round_ordinal} • Slot {enc.slot_ordinal}</Badge>
                              <span style={{ fontWeight: 700 }}>{enc.team_a_name || 'Đội A'}</span>
                              <span style={{ color: 'var(--text-secondary)' }}>vs</span>
                              <span style={{ fontWeight: 700 }}>{enc.team_b_name || 'Đội B'}</span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                              <span style={{ fontWeight: 800, fontSize: '18px' }}>
                                {enc.points_a} : {enc.points_b}
                              </span>
                              <Badge variant={enc.status === 'COMPLETED' ? 'success' : 'warning'}>
                                {enc.status}
                              </Badge>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        )}

        {/* VIEW 2: ESPORTS MATCHROOM & CANVAS 2D VISUALIZER */}
        {activeView === 'MATCHROOM' && (
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
            {/* Esports Scoreboard Banner */}
            <ScoreboardBanner
              teamAName="Phoenix Squad (White)"
              teamBName="Vanguard Esports (Black)"
              scoreA={currentSnapshot.turnNumber > 0 ? 1 : 0}
              scoreB={0}
              status="LIVE"
              mapName={replay.init.map.mapName || 'Donut Citadel'}
              currentTurn={currentTurn}
              maxTurns={replay.snapshots.length - 1}
            />

            {/* Canvas 2D Board Viewport */}
            <div style={{ flex: 1, position: 'relative', minHeight: 0, backgroundColor: '#070a12' }}>
              <CanvasViewport
                boardWidth={replay.init.map.width}
                boardHeight={replay.init.map.height}
                validTiles={validTilesSet}
                whiteThrone={replay.init.map.whiteThrone}
                blackThrone={replay.init.map.blackThrone}
                pieces={currentSnapshot.pieces}
                lastMove={currentSnapshot.lastMove}
              />
            </div>

            {/* Bottom Timeline Controls */}
            <Timeline
              currentTurn={currentTurn}
              totalTurns={replay.snapshots.length - 1}
              isPlaying={isPlaying}
              playbackSpeed={playbackSpeed}
              onPlayPause={() => setIsPlaying(!isPlaying)}
              onStepPrev={() => setCurrentTurn((prev) => Math.max(0, prev - 1))}
              onStepNext={() => setCurrentTurn((prev) => Math.min(replay.snapshots.length - 1, prev + 1))}
              onSeekTo={(turn) => setCurrentTurn(turn)}
              onSpeedChange={(speed) => setPlaybackSpeed(speed)}
            />
          </div>
        )}

        {/* VIEW 3: TEAM WORKSPACE & MULTI-FILE IDE */}
        {activeView === 'WORKSPACE' && (
          <div style={{ padding: '24px', height: '100%', display: 'flex', flexDirection: 'column' }}>
            <MultiFileEditor
              teamId="team_demo_001"
              tournamentId={selectedTournament?.id || 'tourney_active'}
              initialLanguage="PYTHON"
              onRunPrivateTest={async ({ language, entrypoint, files }) => {
                // Simulated or real test execution
                await delay(800);
              }}
              onSubmitOfficial={async ({ language, entrypoint, files }) => {
                await delay(1000);
              }}
            />
          </div>
        )}

        {/* VIEW 4: ORGANIZER DASHBOARD & MAP EDITOR */}
        {activeView === 'ORGANIZER' && (
          <div style={{ padding: '24px', overflow: 'auto' }}>
            <MapEditor
              onSave={async (map) => {
                await fetch('/api/v2/organizer/maps', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(map),
                });
              }}
            />
          </div>
        )}
      </main>
    </div>
  );
};
