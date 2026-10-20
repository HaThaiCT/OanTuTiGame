'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import ReplayBoard from '../../replays/ReplayBoard';
import { TeamRatingName } from '../../_components/TeamRatingName';
import { TournamentRatingProvider } from '../../_components/TournamentRatingContext';
import { sideLabel, winReasonLabel } from '../../../lib/labels';
import { buildBoardFrames } from '../../../lib/replay';
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

/** The four states the spectator screen reports; the socket itself only ever has a subset. */
type Connection = 'connecting' | 'live' | 'finished' | 'closed';

/** Reconnect policy for an unexpected close mid-game (see `onclose` below). */
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAYS_MS = [1000, 2000, 4000];
/** The server closes with 4404 for an unknown or expired game (see the live route contract). */
const CLOSE_UNKNOWN_GAME = 4404;
const NO_LIVE_NOTICE = 'Không có trận trực tiếp cho mã này (có thể đã kết thúc quá 5 phút)';

const CONNECTION_LABEL: Record<Connection, string> = {
  connecting: 'Đang kết nối',
  live: 'Đang trực tiếp',
  finished: 'Đã kết thúc',
  closed: 'Đã đóng kết nối',
};

const CONNECTION_CLASS: Record<Connection, string> = {
  connecting: 'border-[var(--border-control)] bg-[var(--surface-subtle)] text-[var(--text-primary)]',
  live: 'border-[var(--live-accent)] bg-[rgba(253,186,116,0.15)] text-[var(--live-accent)]',
  finished: 'border-[var(--accent-secondary)] bg-[rgba(103,232,249,0.12)] text-[var(--accent-secondary)]',
  closed: 'border-[var(--danger-text)] bg-[rgba(254,202,202,0.12)] text-[var(--danger-text)]',
};

const LIVE_STATUS_LABEL: Record<LiveStatus, string> = {
  RUNNING: 'Đang diễn ra',
  PREVIEW_ENDED: 'Đang chờ kết quả được xác nhận',
  FINISHED: 'Đã kết thúc',
};

function teamName(team: LiveTeam | null): string {
  const name = team?.name.trim();
  return name ? name : 'Đội chưa đặt tên';
}

function describePly(ply: LivePly): string {
  const side = sideLabel[String(ply.side)] ?? `Phe ${ply.side}`;
  return ply.action.action === 'MOVE'
    ? `${side}: quân #${ply.action.pieceId} tới (${ply.action.target[0]}, ${ply.action.target[1]})`
    : `${side}: bỏ lượt (PASS)`;
}

/**
 * Live spectator of one running game.
 *
 * The snapshot is the only source of truth: on connect (and on every reconnect) the server resends
 * the whole history, so the ply list is *replaced* by `snapshot.events` and each later `EVENT` is
 * appended — nothing is ever synthesised locally. The board is derived from that ply list through the
 * same reconstruction engine the replay viewer uses (`buildBoardFrames`), so a live screen and a
 * replay of the same game show the same rules, moves and capture marks.
 */
export default function LiveViewer({ gameId, canViewReplay = false }: { readonly gameId: string; readonly canViewReplay?: boolean }) {
  const [connection, setConnection] = useState<Connection>('connecting');
  const [notice, setNotice] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [plies, setPlies] = useState<readonly LivePly[]>([]);
  const pliesRef = useRef<readonly LivePly[]>([]);
  const [outcome, setOutcome] = useState<LiveOutcome | null>(null);

  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let attempts = 0;
    // A FINISHED snapshot or a RESULT frame ends the stream on purpose: that close is never retried.
    let finished = false;
    let identity: LiveSnapshot | null = null;
    let lastSeq = 0;

    const openSocket = () => {
      if (cancelled) return;
      setConnection('connecting');

      let next: WebSocket;
      try {
        next = new WebSocket(liveSocketUrl(gameId));
      } catch {
        setConnection('closed');
        setNotice('Không mở được kết nối WebSocket tới API — kiểm tra lại địa chỉ socket của server.');
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
        if (!message) {
          setNotice('Server gửi một thông điệp không nhận dạng được — đã bỏ qua để không dựng sai thế cờ.');
          return;
        }

        if (message.type === 'SNAPSHOT') {
          const incoming = message.snapshot;
          if (incoming.gameId !== gameId) return;
          identity = incoming;
          lastSeq = incoming.seq;
          finished = incoming.status === 'FINISHED';
          setSnapshot(incoming);
          pliesRef.current = incoming.historyComplete ? incoming.events : [];
          setPlies(pliesRef.current);
          setOutcome(incoming.outcome);
          setNotice(
            !incoming.historyComplete
              ? 'Lịch sử trực tiếp đã vượt giới hạn bộ đệm — không dựng bàn cờ từ lịch sử thiếu.'
              : incoming.status === 'PREVIEW_ENDED'
                ? 'Bản xem trước đã dừng; đang chờ hệ thống xác nhận kết quả chính thức.'
                : incoming.map ? null : 'Server không gửi bàn đấu cho ván này nên không thể dựng lại thế cờ.'
          );
          setConnection(finished ? 'finished' : 'live');
          return;
        }

        if (message.type !== 'PING' && (!identity || !sameLiveIdentity(identity, message.identity))) return;
        if (message.type === 'PREVIEW_ENDED') {
          setSnapshot((current) => current ? { ...current, status: 'PREVIEW_ENDED' } : current);
          setNotice('Bản xem trước đã dừng; đang chờ hệ thống xác nhận kết quả chính thức.');
          return;
        }

        if (message.type === 'EVENT') {
          if (finished) return;
          if (message.ply.seq === null || message.ply.seq <= lastSeq) return;
          if (message.ply.seq !== lastSeq + 1) {
            setNotice('Bỏ lỡ một số nước đi — đang kết nối lại để lấy ảnh trạng thái đầy đủ.');
            socket?.close();
            return;
          }
          lastSeq = message.ply.seq;
          if (identity?.historyComplete) {
            const plies = [...pliesRef.current, message.ply];
            pliesRef.current = plies;
            setPlies(plies);
          }
          setConnection('live');
          return;
        }

        if (message.type === 'PING') {
          // Heartbeat: proves the stream is alive without touching the board state.
          setConnection((current) => (current === 'connecting' ? 'live' : current));
          return;
        }

        finished = true;
        setSnapshot((current) => current ? { ...current, status: 'FINISHED', outcome: message.outcome } : current);
        setNotice(null);
        setOutcome(message.outcome);
        setConnection('finished');
      };

      // `onerror` always precedes `onclose`, and only `onclose` knows the code — so the reconnect
      // policy lives there and `onerror` stays empty rather than racing it.
      next.onerror = () => {};

      next.onclose = (event: CloseEvent) => {
        if (socket !== next) return;
        socket = null;
        if (cancelled) return;

        if (event.code === CLOSE_UNKNOWN_GAME) {
          setConnection('closed');
          setNotice(NO_LIVE_NOTICE);
          return;
        }
        if (finished) {
          setConnection('finished');
          return;
        }
        if (attempts < MAX_RECONNECT_ATTEMPTS) {
          const delay = RECONNECT_DELAYS_MS[attempts] ?? RECONNECT_DELAYS_MS[RECONNECT_DELAYS_MS.length - 1];
          attempts += 1;
          setConnection('connecting');
          setNotice(
            `Mất kết nối (mã ${event.code}) — thử lại lần ${attempts}/${MAX_RECONNECT_ATTEMPTS} sau ${Math.round(delay / 1000)} giây.`
          );
          reconnectTimer = window.setTimeout(openSocket, delay);
          return;
        }
        setConnection('closed');
        setNotice(
          `Mất kết nối với server (mã ${event.code}) và đã thử lại ${MAX_RECONNECT_ATTEMPTS} lần — ván này không còn dữ liệu trực tiếp.`
        );
      };
    };

    openSocket();
    return () => {
      cancelled = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [gameId]);

  /**
   * Board state is derived, never stored. A match is ply-bounded (a few hundred at most), so
   * re-applying the whole ply list per event is cheap and keeps exactly one rule implementation.
   */
  const frames = useMemo(
    () => (snapshot?.map && snapshot.historyComplete ? buildBoardFrames(snapshot.map, plies.map(livePlyToReplayPly)) : null),
    [snapshot, plies]
  );

  const frame = frames ? frames.frames[frames.frames.length - 1] ?? null : null;
  const lastPly = plies.length > 0 ? plies[plies.length - 1] : null;
  const whiteName = teamName(snapshot?.whiteTeam ?? null);
  const blackName = teamName(snapshot?.blackTeam ?? null);

  const winnerText = outcome
    ? outcome.winner === 1
      ? `${whiteName} (Quân Trắng) thắng`
      : outcome.winner === 2
        ? `${blackName} (Quân Đen) thắng`
        : 'Hòa — không xác định bên thắng'
    : null;

  return (
    <div className="flex min-w-0 flex-col gap-4"><TournamentRatingProvider tournamentId={snapshot?.tournamentId ?? ''}>
      <section className="border border-[var(--border-subtle)] bg-[var(--surface)] p-6 rounded-2xl shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--border-subtle)] pb-4 mb-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="font-semibold text-xs text-[var(--text-secondary)]">
                Bàn đấu: <strong className="text-[var(--text-primary)]">{snapshot?.map?.mapName ?? '—'}</strong>
              </span>
            </div>
            <h1 className="font-mono text-xs text-[var(--text-faint)] break-all">
              Mã trận: {gameId}
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <span
              className={`inline-flex items-center gap-1.5 font-mono text-xs font-bold uppercase tracking-wider px-3 py-1 border rounded-full ${CONNECTION_CLASS[connection]}`}
            >
              <span className={`inline-block w-2 h-2 rounded-full ${connection === 'live' ? 'bg-[var(--action)] shadow-[0_0_8px_var(--action)] animate-pulse' : 'bg-current'}`} />
              {CONNECTION_LABEL[connection]}
            </span>
          </div>
        </div>

        {/* Esports Head-to-Head Banner */}
        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] items-center gap-4 py-2">
          <div className="flex items-center gap-3 bg-[var(--surface-subtle)] border border-[var(--border-subtle)] p-4 rounded-xl shadow-xs">
            <span className="inline-block h-4 w-4 border border-white bg-[#ece8e1] rounded-full shrink-0" />
            <div className="min-w-0">
              <p className="text-xs text-[var(--text-secondary)] font-medium">Phe Trắng (White)</p>
              <p className="font-heading text-lg font-bold truncate text-[var(--text-primary)]">
                {snapshot?.whiteTeam ? <TeamRatingName teamId={snapshot.whiteTeam.id} name={whiteName} rating={null} /> : whiteName}
              </p>
            </div>
          </div>

          <div className="text-center px-2">
            <span className="font-heading font-black text-2xl text-[var(--action)] tracking-widest">
              VS
            </span>
          </div>

          <div className="flex items-center justify-end gap-3 bg-[var(--surface-subtle)] border border-[var(--border-subtle)] p-4 rounded-xl shadow-xs text-right">
            <div className="min-w-0">
              <p className="text-xs text-[var(--text-secondary)] font-medium">Phe Đen (Black)</p>
              <p className="font-heading text-lg font-bold truncate text-[var(--text-primary)]">
                {snapshot?.blackTeam ? <TeamRatingName teamId={snapshot.blackTeam.id} name={blackName} rating={null} /> : blackName}
              </p>
            </div>
            <span className="inline-block h-4 w-4 border border-[#00f5d4] bg-[#101720] rounded-full shrink-0" />
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mt-4 pt-4 border-t border-[var(--border-subtle)] font-mono text-xs">
          <div>
            <p className="text-[var(--text-secondary)] text-xs font-medium">Số nước đã đi</p>
            <p className="mt-1 font-heading text-2xl font-bold text-[var(--text-primary)] tabular-nums">{plies.length}</p>
          </div>
          <div className="col-span-2 md:col-span-2">
            <p className="text-[var(--text-secondary)] text-xs font-medium">Nước gần nhất</p>
            <p className="mt-1 text-sm text-[var(--accent-secondary)] truncate">
              {lastPly ? `Nước ${lastPly.turnNumber}: ${describePly(lastPly)}` : 'Chưa có nước đi'}
            </p>
          </div>
        </div>
      </section>

      {notice ? (
        <div className="border border-[var(--warning-text)] bg-[var(--warning-tint)] px-4 py-3 rounded-xl text-xs text-[var(--warning-text)] shadow-xs">
          {notice}
        </div>
      ) : null}

      {outcome ? (
        <section className="border border-[var(--action)] bg-[rgba(255,70,85,0.08)] p-6 rounded-2xl shadow-sm">
          <p className="text-xs font-bold text-[var(--action)]">Kết quả trận đấu</p>
          <h2 className="mt-1 font-heading text-xl font-bold text-[var(--text-primary)]">
            {outcome.winner === 1 && snapshot?.whiteTeam ? (
              <>
                <TeamRatingName teamId={snapshot.whiteTeam.id} name={whiteName} rating={null} />{' '}
                <span className="text-[var(--action)]">(Quân Trắng) thắng</span>
              </>
            ) : outcome.winner === 2 && snapshot?.blackTeam ? (
              <>
                <TeamRatingName teamId={snapshot.blackTeam.id} name={blackName} rating={null} />{' '}
                <span className="text-[var(--action)]">(Quân Đen) thắng</span>
              </>
            ) : (
              winnerText
            )}
          </h2>
          <p className="mt-2 font-mono text-xs text-[var(--text-secondary)]">
            LÝ DO:{' '}
            <strong className="text-[var(--text-primary)] uppercase">
              {winReasonLabel[outcome.reason] ?? (outcome.reason || 'KHÔNG RÕ')}
            </strong>
            {outcome.reason ? <span className="ml-2 font-mono text-[10px] text-[var(--text-faint)]">[{outcome.reason}]</span> : null}
          </p>
        </section>
      ) : null}

      {connection === 'finished' && canViewReplay ? (
        <Link
          className="vct-btn-primary self-start !py-2 !px-4 !text-xs !rounded-full"
          href={`/replays?game=${encodeURIComponent(gameId)}`}
        >
          Xem lại toàn bộ ván đấu (Replay) →
        </Link>
      ) : null}

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <section className="flex min-w-0 flex-col gap-4 rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-3 sm:p-4">
          {frames && frame ? (
            <>
              <div className="overflow-x-auto">
                <div className="min-w-0">
                  <ReplayBoard descriptor={frames.descriptor} frame={frame} />
                </div>
              </div>
              {frame.note ? (
                <p className="rounded-sm border border-[var(--border-subtle)] bg-[var(--warning-tint)] px-3 py-2 text-xs text-[var(--warning-text)]">
                  {frame.note}
                </p>
              ) : null}
            </>
          ) : (
            <p className="rounded-sm border border-dashed border-[var(--border-subtle)] px-4 py-12 text-center text-sm text-[var(--text-secondary)]">
              {snapshot
                ? 'Server không gửi bàn đấu (map descriptor) cho ván này nên không có gì để vẽ.'
                : connection === 'closed' || connection === 'finished'
                  ? 'Chưa nhận được dữ liệu ván từ server nên không có thế cờ để hiển thị.'
                  : 'Đang chờ thế cờ đầu tiên từ server…'}
            </p>
          )}
        </section>

        <aside className="flex min-w-0 flex-col gap-4 self-start rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] px-4 py-4 text-sm">
          <div>
            <h2 className="text-sm font-semibold">Theo dõi trực tiếp</h2>
            <p className="mt-1 text-[var(--text-secondary)]">
              Bảng đấu được dựng lại từ chuỗi sự kiện server phát đi, không thêm bớt nước nào.
            </p>
          </div>
          <div>
            <p className="text-xs text-[var(--text-secondary)]">Trạng thái phiên</p>
            <p className="font-semibold">{CONNECTION_LABEL[connection]}</p>
          </div>
          <div>
            <p className="text-xs text-[var(--text-secondary)]">Nước gần nhất</p>
            <p className="font-semibold">
              {lastPly ? `Lượt ${lastPly.turnNumber} — ${describePly(lastPly)}` : 'Chưa có nước nào'}
            </p>
          </div>
          <div>
            <p className="text-xs text-[var(--text-secondary)]">Số nước đã đi</p>
            <p className="font-semibold tabular-nums">{plies.length}</p>
          </div>
          {frame?.captured ? (
            <div>
              <p className="text-xs text-[var(--text-secondary)]">Quân vừa bị ăn ở nước cuối</p>
              <p className="font-semibold">
                #{frame.captured.id} tại ({frame.captured.x}, {frame.captured.y})
              </p>
            </div>
          ) : null}
          {frames && frames.warnings.length > 0 ? (
            <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--warning-tint)] px-3 py-2 text-xs text-[var(--warning-text)]">
              <p className="font-semibold">Một số nước không dựng lại được đúng như engine:</p>
              <ul className="mt-2 list-disc space-y-1 pl-4">
                {frames.warnings.slice(0, 4).map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
              {frames.warnings.length > 4 ? <p className="mt-1">… và {frames.warnings.length - 4} cảnh báo khác.</p> : null}
            </div>
          ) : null}
        </aside>
      </div>
    </TournamentRatingProvider>
    </div>
  );
}
