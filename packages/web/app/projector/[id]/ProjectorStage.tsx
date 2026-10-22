'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import ReplayBoard from '../../replays/ReplayBoard';
import { TeamRatingName } from '../../_components/TeamRatingName';
import { TournamentRatingProvider } from '../../_components/TournamentRatingContext';
import { sideLabel, winReasonLabel } from '../../../lib/labels';
import { buildBoardFrames, type ReplayFrame, type ReplayMapDescriptor } from '../../../lib/replay';
import {
  livePlyToReplayPly,
  liveSocketUrl,
  parseLiveMessage,
  sameLiveIdentity,
  type LiveOutcome,
  type LivePly,
  type LiveSnapshot,
  type LiveStatus,
  type LiveTeam,
} from '../../../lib/live';
import type { BracketEncounter, BracketGame } from '../../../lib/api';

type Connection = 'connecting' | 'live' | 'finished' | 'closed' | 'idle';

const CONNECTION_LABEL: Record<Connection, string> = {
  connecting: 'Đang kết nối live',
  live: 'Trực tiếp (Live)',
  finished: 'Ván đã kết thúc',
  closed: 'Đã đóng kết nối',
  idle: 'Chờ ván đấu',
};

const CONNECTION_CLASS: Record<Connection, string> = {
  connecting: 'border-[var(--warning-text)] bg-[var(--warning-tint)] text-[var(--warning-text)]',
  live: 'border-[var(--action)] bg-[rgba(255,115,125,0.15)] text-[var(--action)]',
  finished: 'border-[var(--accent-secondary)] bg-[rgba(0,245,212,0.12)] text-[var(--accent-secondary)]',
  closed: 'border-[var(--border-control)] bg-[var(--surface-subtle)] text-[var(--text-secondary)]',
  idle: 'border-[var(--border-control)] bg-[var(--surface-subtle)] text-[var(--text-secondary)]',
};

function describePly(ply: LivePly): string {
  const side = sideLabel[String(ply.side)] ?? `Phe ${ply.side}`;
  return ply.action.action === 'MOVE'
    ? `${side}: quân #${ply.action.pieceId} tới (${ply.action.target[0]}, ${ply.action.target[1]})`
    : `${side}: bỏ lượt (PASS)`;
}

export interface ProjectorStageProps {
  readonly tournamentId: string;
  readonly activeGameId: string | null;
  readonly activeEncounter: BracketEncounter | null;
  readonly activeGame: BracketGame | null;
  readonly fallbackDescriptor: ReplayMapDescriptor | null;
  readonly allGames: readonly { readonly encounter: BracketEncounter; readonly game: BracketGame }[];
  readonly isAutoFollow: boolean;
  readonly onToggleAutoFollow: () => void;
  readonly onSelectGame: (gameId: string) => void;
}

export default function ProjectorStage({
  tournamentId,
  activeGameId,
  activeEncounter,
  activeGame,
  fallbackDescriptor,
  allGames,
  isAutoFollow,
  onToggleAutoFollow,
  onSelectGame,
}: ProjectorStageProps) {
  const [connection, setConnection] = useState<Connection>('idle');
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [plies, setPlies] = useState<readonly LivePly[]>([]);
  const pliesRef = useRef<readonly LivePly[]>([]);
  const [outcome, setOutcome] = useState<LiveOutcome | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Connect to live WebSocket whenever activeGameId changes
  useEffect(() => {
    if (!activeGameId) {
      setConnection('idle');
      setSnapshot(null);
      setPlies([]);
      pliesRef.current = [];
      setOutcome(null);
      setNotice(null);
      return;
    }

    let cancelled = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let attempts = 0;
    let finished = false;
    let identity: LiveSnapshot | null = null;
    let lastSeq = 0;

    const openSocket = () => {
      if (cancelled) return;
      setConnection('connecting');

      let next: WebSocket;
      try {
        next = new WebSocket(liveSocketUrl(activeGameId));
      } catch {
        setConnection('closed');
        setNotice('Không thể mở kết nối WebSocket trực tiếp.');
        return;
      }
      socket = next;

      next.onopen = () => {
        if (!cancelled) setConnection('live');
      };

      next.onmessage = (event: MessageEvent) => {
        if (cancelled || socket !== next || typeof event.data !== 'string') return;
        let raw: unknown;
        try {
          raw = JSON.parse(event.data);
        } catch {
          return;
        }

        const message = parseLiveMessage(raw);
        if (!message) return;

        if (message.type === 'SNAPSHOT') {
          const incoming = message.snapshot;
          if (incoming.gameId !== activeGameId) return;
          identity = incoming;
          lastSeq = incoming.seq;
          finished = incoming.status === 'FINISHED';
          setSnapshot(incoming);
          pliesRef.current = incoming.historyComplete ? incoming.events : [];
          setPlies(pliesRef.current);
          setOutcome(incoming.outcome);
          setConnection(finished ? 'finished' : 'live');
          return;
        }

        if (message.type !== 'PING' && (!identity || !sameLiveIdentity(identity, message.identity))) return;

        if (message.type === 'EVENT') {
          if (finished) return;
          if (message.ply.seq === null || message.ply.seq <= lastSeq) return;
          lastSeq = message.ply.seq;
          if (identity?.historyComplete) {
            const nextPlies = [...pliesRef.current, message.ply];
            pliesRef.current = nextPlies;
            setPlies(nextPlies);
          }
          setConnection('live');
          return;
        }

        if (message.type === 'PING') {
          setConnection((curr) => (curr === 'connecting' ? 'live' : curr));
          return;
        }

        if (message.type === 'PREVIEW_ENDED') {
          setSnapshot((curr) => (curr ? { ...curr, status: 'PREVIEW_ENDED' } : curr));
          return;
        }

        if (message.type === 'RESULT') {
          finished = true;
          setSnapshot((curr) => (curr ? { ...curr, status: 'FINISHED', outcome: message.outcome } : curr));
          setOutcome(message.outcome);
          setConnection('finished');
          return;
        }
      };
      next.onerror = () => {};

      next.onclose = () => {
        if (socket !== next) return;
        socket = null;
        if (cancelled) return;
        if (finished) {
          setConnection('finished');
          return;
        }
        if (attempts < 2) {
          attempts += 1;
          reconnectTimer = window.setTimeout(openSocket, 1500);
          return;
        }
        setConnection(activeGame?.status === 'COMPLETED' ? 'finished' : 'closed');
      };
    };

    openSocket();
    return () => {
      cancelled = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [activeGameId, activeGame?.status]);

  // Derive board frames from live snapshot or fallback to tournament map
  const activeDescriptor = snapshot?.map ?? fallbackDescriptor;
  const frames = useMemo(() => {
    if (!activeDescriptor) return null;
    return buildBoardFrames(activeDescriptor, plies.map(livePlyToReplayPly));
  }, [activeDescriptor, plies]);

  const currentFrame = frames ? frames.frames[frames.frames.length - 1] ?? null : null;
  const lastPly = plies.length > 0 ? plies[plies.length - 1] : null;

  const teamAName = snapshot?.whiteTeam?.name ?? activeEncounter?.teamAName ?? 'Đội Trắng';
  const teamBName = snapshot?.blackTeam?.name ?? activeEncounter?.teamBName ?? 'Đội Đen';
  const teamAId = snapshot?.whiteTeam?.id ?? activeEncounter?.teamAId ?? '';
  const teamBId = snapshot?.blackTeam?.id ?? activeEncounter?.teamBId ?? '';

  const isLive = connection === 'live';

  return (
    <TournamentRatingProvider tournamentId={tournamentId}>
      <section className="flex flex-col rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] shadow-lg overflow-hidden">
        {/* Stage Header & Head-to-Head Banner */}
        <div className="flex flex-col border-b border-[var(--border-subtle)] bg-[var(--surface-subtle)]">
          {/* Status Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 border-b border-[var(--border-subtle)] text-xs font-mono">
            <div className="flex items-center gap-3">
              <span className="font-heading font-black text-xs uppercase tracking-wider text-[var(--action)]">
                ★ SÂN ĐẤU TRUNG TÂM
              </span>
              <span>·</span>
              <span className="text-[var(--text-secondary)]">
                {activeEncounter ? `Vòng ${activeEncounter.roundOrdinal} · Trận #${activeEncounter.slotOrdinal}` : 'Sẵn sàng'}
              </span>
              {activeGame ? (
                <>
                  <span>·</span>
                  <span className="text-[var(--text-primary)] font-semibold">
                    Ván #{activeGame.gameOrdinal}
                  </span>
                </>
              ) : null}
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={onToggleAutoFollow}
                className={`px-3 py-1 rounded-full text-xs font-bold transition-all ${
                  isAutoFollow
                    ? 'bg-[var(--action)] text-[var(--action-text)] shadow-xs'
                    : 'border border-[var(--border-control)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
                title="Tự động chuyển sang ván đấu đang diễn ra"
              >
                {isAutoFollow ? '● Tự động theo dõi Live: BẬT' : '○ Tự động theo dõi Live: TẮT'}
              </button>

              <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider border ${CONNECTION_CLASS[connection]}`}>
                <span className={`w-2 h-2 rounded-full ${isLive ? 'bg-[var(--action)] animate-pulse shadow-[0_0_8px_var(--action)]' : 'bg-current'}`} />
                {CONNECTION_LABEL[connection]}
              </span>
            </div>
          </div>

          {/* Esports VS Banner */}
          <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] items-center gap-4 px-6 py-4">
            {/* White Team */}
            <div className="flex items-center gap-4 bg-[var(--surface)] border border-[var(--border-subtle)] p-4 rounded-xl shadow-xs">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 border-white bg-[#ece8e1] text-xs font-bold text-[#0b1118] shadow-sm">
                TRẮNG
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-mono uppercase tracking-wider text-[var(--text-secondary)]">Phe Trắng (Side 1)</p>
                <div className="font-heading text-lg font-black truncate text-[var(--text-primary)]">
                  {teamAId ? <TeamRatingName teamId={teamAId} name={teamAName} rating={null} /> : teamAName}
                </div>
              </div>
              {activeEncounter ? (
                <span className="font-heading text-3xl font-black tabular-nums text-[var(--text-primary)]">
                  {activeEncounter.pointsA}
                </span>
              ) : null}
            </div>

            {/* Match Center / Score */}
            <div className="flex flex-col items-center justify-center text-center px-4">
              <span className="font-heading font-black text-2xl text-[var(--action)] tracking-widest drop-shadow-sm">
                VS
              </span>
              {activeEncounter ? (
                <span className="mt-1 font-mono text-xs text-[var(--text-secondary)]">
                  TỈ SỐ TRẬN
                </span>
              ) : (
                <span className="mt-1 font-mono text-xs text-[var(--text-secondary)]">
                  CHỜ CẶP ĐẤU
                </span>
              )}
            </div>

            {/* Black Team */}
            <div className="flex items-center justify-end gap-4 bg-[var(--surface)] border border-[var(--border-subtle)] p-4 rounded-xl shadow-xs text-right">
              {activeEncounter ? (
                <span className="font-heading text-3xl font-black tabular-nums text-[var(--text-primary)]">
                  {activeEncounter.pointsB}
                </span>
              ) : null}
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-mono uppercase tracking-wider text-[var(--text-secondary)]">Phe Đen (Side 2)</p>
                <div className="font-heading text-lg font-black truncate text-[var(--text-primary)]">
                  {teamBId ? <TeamRatingName teamId={teamBId} name={teamBName} rating={null} /> : teamBName}
                </div>
              </div>
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 border-[#00f5d4] bg-[#101720] text-xs font-bold text-[#00f5d4] shadow-sm">
                ĐEN
              </span>
            </div>
          </div>
        </div>

        {/* Center Stage: The Live Board Arena */}
        <div className="py-4 px-6 flex flex-col items-center justify-center min-h-[320px] bg-[var(--canvas)]">
          {activeDescriptor && currentFrame ? (
            <div className="w-full max-w-[480px] lg:max-w-[540px] transition-all">
              <ReplayBoard descriptor={activeDescriptor} frame={currentFrame} />
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-16 text-center text-[var(--text-secondary)] font-mono">
              <p className="text-base font-semibold text-[var(--text-primary)]">
                Bàn đấu đang sẵn sàng
              </p>
              <p className="mt-2 text-xs max-w-md">
                {activeGameId
                  ? 'Đang kết nối nhận dữ liệu bàn đấu từ máy chủ...'
                  : 'Chưa có ván đấu nào đang diễn ra. Chọn một ván từ danh sách bên dưới để chiếu lên sân khấu.'}
              </p>
            </div>
          )}
        </div>

        {/* Live Match Telemetry Strip */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 p-4 border-t border-[var(--border-subtle)] bg-[var(--surface-subtle)] text-xs font-mono">
          <div className="bg-[var(--surface)] p-3 rounded-lg border border-[var(--border-subtle)]">
            <p className="text-[var(--text-secondary)] font-medium">NƯỚC GẦN NHẤT</p>
            <p className="mt-1 text-sm font-semibold text-[var(--accent-secondary)] truncate">
              {lastPly ? `Nước ${lastPly.turnNumber}: ${describePly(lastPly)}` : 'Chưa có'}
            </p>
          </div>

          <div className="bg-[var(--surface)] p-3 rounded-lg border border-[var(--border-subtle)]">
            <p className="text-[var(--text-secondary)] font-medium">SỐ NƯỚC ĐÃ ĐI</p>
            <p className="mt-1 text-xl font-heading font-black tabular-nums text-[var(--text-primary)]">
              {plies.length}
            </p>
          </div>

          <div className="bg-[var(--surface)] p-3 rounded-lg border border-[var(--border-subtle)]">
            <p className="text-[var(--text-secondary)] font-medium">QUÂN VỪA BỊ ĂN</p>
            <p className="mt-1 text-sm font-semibold text-[var(--text-primary)] truncate">
              {currentFrame?.captured
                ? `Quân #${currentFrame.captured.id} tại (${currentFrame.captured.x}, ${currentFrame.captured.y})`
                : '—'}
            </p>
          </div>

          <div className="bg-[var(--surface)] p-3 rounded-lg border border-[var(--border-subtle)]">
            <p className="text-[var(--text-secondary)] font-medium">TRẠNG THÁI VÁN</p>
            <p className="mt-1 text-sm font-semibold text-[var(--action)] truncate">
              {outcome
                ? outcome.winner === 1
                  ? `${teamAName} THẮNG (${winReasonLabel[outcome.reason] ?? outcome.reason})`
                  : outcome.winner === 2
                    ? `${teamBName} THẮNG (${winReasonLabel[outcome.reason] ?? outcome.reason})`
                    : `HÒA (${winReasonLabel[outcome.reason] ?? outcome.reason})`
                : activeGame
                  ? activeGame.status === 'RUNNING'
                    ? '● ĐANG THI ĐẤU TRỰC TIẾP'
                    : activeGame.status === 'COMPLETED'
                      ? 'ĐÃ KẾT THÚC'
                      : 'CHỜ BẮT ĐẦU'
                  : 'CHỜ TRẬN ĐẤU'}
            </p>
          </div>
        </div>

        {/* Quick Game Switcher (if tournament has multiple games) */}
        {allGames.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 px-5 py-3 border-t border-[var(--border-subtle)] bg-[var(--surface)] text-xs font-mono">
            <span className="text-[var(--text-secondary)] font-medium shrink-0">
              CHUYỂN VÁN NHANH:
            </span>
            <div className="flex flex-wrap items-center gap-2 overflow-x-auto">
              {allGames.map(({ encounter, game }) => {
                const isSelected = game.gameId === activeGameId;
                const isRunning = game.status === 'RUNNING';
                return (
                  <button
                    key={game.gameId}
                    type="button"
                    onClick={() => onSelectGame(game.gameId)}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-all ${
                      isSelected
                        ? 'border-[var(--action)] bg-[var(--action)] text-[var(--action-text)] font-bold shadow-xs'
                        : isRunning
                          ? 'border-[var(--live-accent)] bg-[rgba(255,115,125,0.12)] text-[var(--live-accent)] animate-pulse'
                          : 'border-[var(--border-control)] bg-[var(--surface-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    Vòng {encounter.roundOrdinal} · #{encounter.slotOrdinal} (Ván {game.gameOrdinal})
                    {isRunning ? ' ● LIVE' : ''}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </section>
    </TournamentRatingProvider>
  );
}
