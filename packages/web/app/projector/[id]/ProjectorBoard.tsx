'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  normalizeAnnouncementsPayload,
  normalizeBracketPayload,
  normalizeBracketRounds,
  normalizeStandingsPayload,
  normalizeTournamentRow,
  type Announcement,
  type BracketEncounter,
  type BracketRound,
  type MapCommitment,
  type StandingsSnapshot,
  type TournamentSummary,
} from '../../../lib/api';
import { formatLabel, stateLabel } from '../../../lib/labels';
import type { ReplayMapDescriptor } from '../../../lib/replay';
import { TournamentRatingProvider } from '../../_components/TournamentRatingContext';
import UetLogo from '../../_components/UetLogo';
import ProjectorStage from './ProjectorStage';
import ProjectorMatchesLive from './ProjectorMatchesLive';
import ProjectorBracket from './ProjectorBracket';
import ProjectorSchedule from './ProjectorSchedule';
import ProjectorStandings from './ProjectorStandings';

const REFRESH_MS = 10_000;

type HubTab = 'MATCHES' | 'BRACKET' | 'SCHEDULE' | 'STANDINGS' | 'ANNOUNCEMENTS';

export interface ProjectorBoardProps {
  readonly tournamentId: string;
  readonly initialTournament: TournamentSummary;
  readonly initialBracket: BracketEncounter[] | null;
  readonly initialRounds: readonly BracketRound[];
  readonly initialStandings: StandingsSnapshot;
  readonly initialAnnouncements: Announcement[] | null;
  readonly initialCommitment?: MapCommitment | null;
  readonly initialMap?: ReplayMapDescriptor | null;
}

export default function ProjectorBoard({
  tournamentId,
  initialTournament,
  initialBracket,
  initialRounds,
  initialStandings,
  initialAnnouncements,
  initialCommitment = null,
  initialMap = null,
}: ProjectorBoardProps) {
  const [tournament, setTournament] = useState<TournamentSummary>(initialTournament);
  const [bracket, setBracket] = useState<BracketEncounter[] | null>(initialBracket);
  const [roundMeta, setRoundMeta] = useState<readonly BracketRound[]>(initialRounds);
  const [standings, setStandings] = useState<StandingsSnapshot>(initialStandings);
  const [announcements, setAnnouncements] = useState<Announcement[] | null>(initialAnnouncements);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [stale, setStale] = useState(false);
  const [copied, setCopied] = useState(false);

  // Active game projection state
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null);
  const [isAutoFollow, setIsAutoFollow] = useState(true);
  const [activeTab, setActiveTab] = useState<HubTab>('MATCHES');

  // Collect all games in the tournament
  const allGames = useMemo(() => {
    if (!bracket) return [];
    const list: { encounter: BracketEncounter; game: { gameId: string; gameOrdinal: number; status: string } }[] = [];
    for (const encounter of bracket) {
      for (const game of encounter.games) {
        list.push({ encounter, game });
      }
    }
    return list;
  }, [bracket]);

  // Determine which game should be active on the main stage
  const activeGameId = useMemo(() => {
    if (!isAutoFollow && selectedGameId) {
      return selectedGameId;
    }
    // If auto-follow, prioritize the first game with status RUNNING
    const runningGame = allGames.find((item) => item.game.status === 'RUNNING');
    if (runningGame) {
      return runningGame.game.gameId;
    }
    // If no running game, stay on selected game if set, otherwise pick the latest or first game
    if (selectedGameId) {
      return selectedGameId;
    }
    if (allGames.length > 0) {
      return allGames[allGames.length - 1]?.game.gameId ?? null;
    }
    return null;
  }, [isAutoFollow, selectedGameId, allGames]);

  // Resolve matching encounter and game object
  const activeMatch = useMemo(() => {
    if (!activeGameId || !bracket) return { encounter: null, game: null };
    for (const encounter of bracket) {
      const matchGame = encounter.games.find((g) => g.gameId === activeGameId);
      if (matchGame) return { encounter, game: matchGame };
    }
    return { encounter: null, game: null };
  }, [activeGameId, bracket]);

  // Auto-refresh tournament data every 10 seconds
  useEffect(() => {
    let cancelled = false;
    const base = `/api/v2/tournaments/${encodeURIComponent(tournamentId)}`;

    const read = async (path: string): Promise<Record<string, unknown> | null> => {
      try {
        const response = await fetch(path, { cache: 'no-store' });
        if (!response.ok) return null;
        const payload: unknown = await response.json();
        return payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    };

    const refresh = async () => {
      const [tournamentRow, bracketPayload, standingsPayload, announcementsPayload] = await Promise.all([
        read(base),
        read(`${base}/bracket`),
        read(`${base}/standings`),
        read(`${base}/announcements`),
      ]);
      if (cancelled) return;
      if (tournamentRow) setTournament(normalizeTournamentRow(tournamentRow));
      if (bracketPayload) {
        setBracket(normalizeBracketPayload(bracketPayload));
        setRoundMeta(normalizeBracketRounds(bracketPayload));
      }
      if (standingsPayload) setStandings(normalizeStandingsPayload(standingsPayload));
      if (announcementsPayload) setAnnouncements(normalizeAnnouncementsPayload(announcementsPayload));
      setStale(!tournamentRow && !bracketPayload && !standingsPayload && !announcementsPayload);
      setRefreshedAt(new Date());
    };

    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, REFRESH_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [tournamentId]);

  async function toggleFullScreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      // Permission or kiosk mode refusal ignored gracefully
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  const runningGamesCount = allGames.filter((g) => g.game.status === 'RUNNING').length;

  return (
    <div data-projector="true" className="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-[var(--canvas-deep)] font-body text-[var(--text-primary)]">
      <TournamentRatingProvider tournamentId={tournamentId}>
        {/* Top Navigation & Projector Control Bar */}
        <header className="sticky top-0 z-40 flex flex-wrap items-center justify-between gap-4 border-b border-[var(--border-subtle)] bg-[var(--header-bg)] px-6 py-4 backdrop-blur-md shadow-md">
          {/* Tournament Branding */}
          <div className="flex items-center gap-4">
            <Link href={`/tournaments/${tournamentId}`} className="flex items-center gap-3 group" title="Quay lại trang giải đấu">
              <UetLogo size={36} priority />
              <div>
                <div className="flex items-baseline gap-1.5">
                  <span className="font-heading font-black text-xl text-[var(--text-primary)] group-hover:text-[var(--action)] transition-colors">
                    OanTuTi
                  </span>
                  <span className="text-xs font-mono font-bold uppercase tracking-widest text-[var(--action)]">
                    ARENA
                  </span>
                </div>
                <p className="text-[10px] font-mono tracking-tight text-[var(--text-secondary)]">UET · ĐHQGHN</p>
              </div>
            </Link>
            <span className="text-[var(--border-control)]">/</span>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-heading text-lg font-black tracking-tight text-[var(--text-primary)]">
                  {tournament.name}
                </span>
                <span className="rounded-full border border-[var(--border-subtle)] bg-[var(--surface)] px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-[var(--accent-secondary)]">
                  {formatLabel[tournament.format] ?? tournament.format}
                </span>
              </div>
              <p className="text-[11px] font-mono text-[var(--text-secondary)]">
                Luật: {tournament.rulesRevision} · Sức chứa: {tournament.maxTeams} đội · Trạng thái: {stateLabel[tournament.state] ?? tournament.state}
              </p>
            </div>
          </div>

          {/* Broadcast Controls */}
          <div className="flex flex-wrap items-center gap-3">
            {/* Live Indicator */}
            {runningGamesCount > 0 ? (
              <span className="flex items-center gap-2 rounded-full border border-[var(--action)] bg-[rgba(255,115,125,0.15)] px-3 py-1 font-mono text-xs font-bold text-[var(--action)] shadow-xs">
                <span className="h-2.5 w-2.5 rounded-full bg-[var(--action)] animate-pulse shadow-[0_0_8px_var(--action)]" />
                {runningGamesCount} VÁN ĐANG TRANH TÀI
              </span>
            ) : (
              <span className="flex items-center gap-2 rounded-full border border-[var(--border-control)] bg-[var(--surface-subtle)] px-3 py-1 font-mono text-xs font-medium text-[var(--text-secondary)]">
                <span className="h-2 w-2 rounded-full bg-current" />
                CHẾ ĐỘ TRÌNH CHIẾU
              </span>
            )}

            {/* Stale warning */}
            {stale ? (
              <span className="font-mono text-xs font-bold text-[var(--danger-text)] animate-bounce">
                ⚠ Mất kết nối máy chủ
              </span>
            ) : null}

            {/* Fullscreen Button */}
            <button
              type="button"
              onClick={() => void toggleFullScreen()}
              className="flex items-center gap-1.5 rounded-lg border border-[var(--border-control)] bg-[var(--surface)] px-3 py-1.5 font-mono text-xs font-semibold text-[var(--text-primary)] hover:border-[var(--action)] transition-all shadow-xs"
            >
              <span>⛶</span> Toàn màn hình
            </button>

            {/* Share / Copy link */}
            <button
              type="button"
              onClick={() => void copyLink()}
              className="rounded-lg border border-[var(--border-control)] bg-[var(--surface)] px-3 py-1.5 font-mono text-xs font-semibold text-[var(--text-primary)] hover:border-[var(--action)] transition-all shadow-xs"
            >
              {copied ? '✓ Đã sao chép' : 'Sao chép link'}
            </button>

            {/* Back link */}
            <Link
              href={`/tournaments/${tournamentId}`}
              className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-3 py-1.5 font-mono text-xs font-semibold text-[var(--action)] hover:border-[var(--action)] transition-all"
            >
              ← Về trang giải
            </Link>
          </div>
        </header>

        {/* Main Content Area */}
        <main className="flex flex-col gap-8 p-6 lg:p-8 max-w-[1800px] mx-auto w-full">
          {/* 1. TOP SECTION: SÂN ĐẤU TRUNG TÂM (Main Stage / Broadcast Arena) */}
          <ProjectorStage
            tournamentId={tournamentId}
            activeGameId={activeGameId}
            activeEncounter={activeMatch.encounter}
            activeGame={activeMatch.game}
            fallbackDescriptor={initialMap}
            allGames={allGames}
            isAutoFollow={isAutoFollow}
            onToggleAutoFollow={() => setIsAutoFollow((prev) => !prev)}
            onSelectGame={(id) => {
              setSelectedGameId(id);
              setIsAutoFollow(false);
            }}
          />

          {/* 2. BOTTOM SECTION: BẢNG ĐIỀU HÀNH & THÔNG TIN TOÀN DIỆN */}
          <section className="flex flex-col rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-6 shadow-md">
            {/* Section Tabs */}
            <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] pb-4 font-mono text-xs font-bold uppercase tracking-wider">
              <button
                type="button"
                onClick={() => setActiveTab('MATCHES')}
                className={`flex items-center gap-2 rounded-xl px-4 py-2.5 transition-all ${
                  activeTab === 'MATCHES'
                    ? 'bg-[var(--action)] text-[var(--action-text)] shadow-sm'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-subtle)]'
                }`}
              >
                <span className="w-2 h-2 rounded-full bg-current" />
                TRỰC TIẾP & KẾT QUẢ CÁC TRẬN ({bracket?.length ?? 0})
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('BRACKET')}
                className={`flex items-center gap-2 rounded-xl px-4 py-2.5 transition-all ${
                  activeTab === 'BRACKET'
                    ? 'bg-[var(--action)] text-[var(--action-text)] shadow-sm'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-subtle)]'
                }`}
              >
                <span>🏆</span> NHÁNH ĐẤU (BRACKET)
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('SCHEDULE')}
                className={`flex items-center gap-2 rounded-xl px-4 py-2.5 transition-all ${
                  activeTab === 'SCHEDULE'
                    ? 'bg-[var(--action)] text-[var(--action-text)] shadow-sm'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-subtle)]'
                }`}
              >
                <span>📅</span> LỊCH THI ĐẤU (SCHEDULE)
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('STANDINGS')}
                className={`flex items-center gap-2 rounded-xl px-4 py-2.5 transition-all ${
                  activeTab === 'STANDINGS'
                    ? 'bg-[var(--action)] text-[var(--action-text)] shadow-sm'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-subtle)]'
                }`}
              >
                <span>📊</span> BẢNG XẾP HẠNG ({standings.rows.length})
              </button>

              {announcements && announcements.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setActiveTab('ANNOUNCEMENTS')}
                  className={`flex items-center gap-2 rounded-xl px-4 py-2.5 transition-all ${
                    activeTab === 'ANNOUNCEMENTS'
                      ? 'bg-[var(--action)] text-[var(--action-text)] shadow-sm'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-subtle)]'
                  }`}
                >
                  <span>📢</span> THÔNG BÁO ({announcements.length})
                </button>
              ) : null}
            </div>

            {/* Tab Panes */}
            <div className="pt-6">
              {activeTab === 'MATCHES' ? (
                <ProjectorMatchesLive
                  encounters={bracket ?? []}
                  activeGameId={activeGameId}
                  onSelectGame={(id) => {
                    setSelectedGameId(id);
                    setIsAutoFollow(false);
                    // Smoothly scroll to the stage
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                />
              ) : null}

              {activeTab === 'BRACKET' ? (
                <ProjectorBracket
                  bracket={bracket ?? []}
                  roundMeta={roundMeta}
                  activeGameId={activeGameId}
                  onSelectGame={(id) => {
                    setSelectedGameId(id);
                    setIsAutoFollow(false);
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                />
              ) : null}

              {activeTab === 'SCHEDULE' ? (
                <ProjectorSchedule
                  encounters={bracket ?? []}
                  activeGameId={activeGameId}
                  onSelectGame={(id) => {
                    setSelectedGameId(id);
                    setIsAutoFollow(false);
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                />
              ) : null}

              {activeTab === 'STANDINGS' ? (
                <ProjectorStandings standings={standings} />
              ) : null}

              {activeTab === 'ANNOUNCEMENTS' && announcements ? (
                <div className="flex flex-col gap-4 font-mono text-xs">
                  <h3 className="font-heading text-lg font-bold text-[var(--text-primary)]">
                    DÒNG THỜI GIAN THÔNG BÁO GIẢI ĐẤU
                  </h3>
                  <div className="divide-y divide-[var(--border-subtle)] rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)]">
                    {announcements.map((a) => (
                      <div key={a.id} className="p-4 flex flex-col gap-1">
                        <div className="flex items-center gap-3">
                          <span className="font-bold text-[var(--action)]">[{a.topic}]</span>
                          <time className="text-[var(--text-secondary)]">{a.createdAt ?? '—'}</time>
                        </div>
                        <p className="text-sm text-[var(--text-primary)] font-body">
                          {typeof a.payload === 'object' && a.payload !== null
                            ? JSON.stringify(a.payload)
                            : String(a.payload ?? '')}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </section>
        </main>
      </TournamentRatingProvider>
    </div>
  );
}
