'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import ReplayBoard from '../../replays/ReplayBoard';
import { sideLabel, winReasonLabel } from '../../../lib/labels';
import { buildBoardFrames } from '../../../lib/replay';
import {
  isSamePly,
  livePlyToReplayPly,
  liveSocketUrl,
  parseLiveMessage,
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
export default function LiveViewer({ gameId }: { readonly gameId: string }) {
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
        if (cancelled || typeof event.data !== 'string') return;
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
          finished = incoming.status === 'FINISHED';
          setSnapshot(incoming);
          pliesRef.current = incoming.events;
          setPlies(incoming.events);
          setOutcome(incoming.outcome);
          setNotice(
            incoming.map
              ? null
              : 'Server không gửi bàn đấu (map descriptor) cho ván này nên không thể dựng lại thế cờ — danh sách nước đi vẫn là dữ liệu thật.'
          );
          setConnection(finished ? 'finished' : 'live');
          return;
        }

        if (message.type === 'EVENT') {
          if (finished) return;
          const current = pliesRef.current;
          const previous = current[current.length - 1] ?? null;
          if (!isSamePly(previous, message.ply)) {
            // A sequence gap means frames were missed: reconnecting buys a fresh snapshot, which
            // is the only honest way to rebuild the board instead of showing a wrong position.
            if (previous?.seq != null && message.ply.seq != null && message.ply.seq !== previous.seq + 1) {
              setNotice('Bỏ lỡ một số nước đi — đang kết nối lại để lấy ảnh trạng thái đầy đủ.');
              socket?.close();
              return;
            }
            const next = [...current, message.ply];
            pliesRef.current = next;
            setPlies(next);
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
        setOutcome(message.outcome);
        setConnection('finished');
      };

      // `onerror` always precedes `onclose`, and only `onclose` knows the code — so the reconnect
      // policy lives there and `onerror` stays empty rather than racing it.
      next.onerror = () => {};

      next.onclose = (event: CloseEvent) => {
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
    () => (snapshot?.map ? buildBoardFrames(snapshot.map, plies.map(livePlyToReplayPly)) : null),
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
    <div className="flex min-w-0 flex-col gap-4">
      <section className="flex flex-wrap items-start justify-between gap-4 rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] px-4 py-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--live-accent)]">Trực tiếp</p>
          <h1 className="mt-1 break-all text-lg font-semibold">{gameId}</h1>
          <p className="mt-2 text-sm text-[var(--text-secondary)]">
            Bàn {snapshot?.map?.mapName ?? '—'} · ván {snapshot ? LIVE_STATUS_LABEL[snapshot.status] : 'chưa có dữ liệu'}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <span className="flex items-center gap-2">
              <span className="inline-block h-3 w-3 rounded-full border border-[#94A3B8] bg-[#F8FAFC]" />
              <span className="text-[var(--text-secondary)]">Quân Trắng</span>
              <span className="font-semibold">{whiteName}</span>
            </span>
            <span className="flex items-center gap-2">
              <span className="inline-block h-3 w-3 rounded-full bg-[#1F2937] ring-1 ring-[var(--border-control)]" />
              <span className="text-[var(--text-secondary)]">Quân Đen</span>
              <span className="font-semibold">{blackName}</span>
            </span>
          </div>
        </div>
        <div className="grid min-w-0 grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
          <div>
            <p className="text-xs text-[var(--text-secondary)]">Kết nối</p>
            <p className="mt-1">
              <span
                className={`inline-flex whitespace-nowrap rounded border px-2 py-0.5 text-xs font-semibold ${CONNECTION_CLASS[connection]}`}
              >
                {CONNECTION_LABEL[connection]}
              </span>
            </p>
          </div>
          <div>
            <p className="text-xs text-[var(--text-secondary)]">Số nước đã đi</p>
            <p className="mt-1 text-lg font-semibold tabular-nums">{plies.length}</p>
          </div>
          <div className="col-span-2 sm:col-span-1">
            <p className="text-xs text-[var(--text-secondary)]">Nước gần nhất</p>
            <p className="mt-1 text-sm font-semibold">
              {lastPly ? `Lượt ${lastPly.turnNumber} — ${describePly(lastPly)}` : 'Chưa có nước nào'}
            </p>
          </div>
        </div>
      </section>

      {notice ? (
        <p className="rounded-md border border-[var(--border-subtle)] bg-[var(--warning-tint)] px-4 py-3 text-sm text-[var(--warning-text)]">
          {notice}
        </p>
      ) : null}

      {outcome ? (
        <section className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] px-4 py-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Kết quả</p>
          <p className="mt-1 text-xl font-semibold">{winnerText}</p>
          <p className="mt-1 text-sm text-[var(--text-primary)]">
            <span className="font-semibold">{winReasonLabel[outcome.reason] ?? (outcome.reason || 'Không rõ lý do')}</span>
            {outcome.reason ? <span className="ml-2 font-mono text-[11px] text-[var(--text-secondary)]">{outcome.reason}</span> : null}
          </p>
        </section>
      ) : null}

      {connection === 'finished' ? (
        <Link
          className="self-start rounded-sm bg-[var(--action)] px-4 py-2 text-sm font-semibold text-[#151618] hover:bg-[var(--action-hover)]"
          href={`/replays?game=${encodeURIComponent(gameId)}`}
        >
          Xem lại toàn bộ ván (replay)
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
    </div>
  );
}
