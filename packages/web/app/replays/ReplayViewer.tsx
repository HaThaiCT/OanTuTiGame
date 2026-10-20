'use client';

import { useCallback, useEffect, useState } from 'react';

import Link from 'next/link';
import { dispositionLabel, sideLabel, winReasonLabel } from '../../lib/labels';
import {
  buildReplayFrames,
  parseReplayBinary,
  verifyReplayChecksum,
  type ParsedReplay,
  type ReplayChecksumStatus,
  type ReplayFrames,
} from '../../lib/replay';
import ReplayBoard from './ReplayBoard';

const SPEEDS = [0.5, 1, 2, 4] as const;

type ViewerState =
  | { readonly phase: 'loading'; readonly message: string }
  | { readonly phase: 'error'; readonly message: string }
  | {
      readonly phase: 'ready';
      readonly replay: ParsedReplay;
      readonly frames: ReplayFrames | null;
      readonly checksum: ReplayChecksumStatus;
      /** Digest actually fetched (resolved from the game result when the page got a game id). */
      readonly digest: string;
    };

/**
 * Fetches `OANTUTI2` bytes (by game id, or straight by digest for private-test replays), verifies
 * the trailing SHA-256 and animates the reconstructed position.
 *
 * Every fetch/parse step runs inside an effect, so the first client render is the deterministic
 * "đang tải" state and hydration can never disagree with the server.
 */
export default function ReplayViewer({
  gameId,
  digest,
  replayEndpoint,
}: {
  readonly gameId: string | null;
  readonly digest: string | null;
  /** Owner-scoped TEST endpoint; never resolve private TEST through the official archive. */
  readonly replayEndpoint?: string;
}) {
  const [state, setState] = useState<ViewerState>({ phase: 'loading', message: 'Đang tải dữ liệu replay…' });
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);

  const frames = state.phase === 'ready' ? state.frames : null;
  const lastIndex = frames ? frames.frames.length - 1 : 0;

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        let replayDigest = digest;
        if (!replayDigest && gameId) {
          if (!cancelled) setState({ phase: 'loading', message: 'Đang đọc kết quả ván…' });
          const resultResponse = await fetch(`/api/v2/games/${encodeURIComponent(gameId)}/result`, {
            cache: 'no-store',
          });
          if (!resultResponse.ok) {
            throw new Error(`Không đọc được kết quả ván ${gameId} (HTTP ${resultResponse.status}).`);
          }
          const resultPayload: unknown = await resultResponse.json();
          const record =
            resultPayload !== null && typeof resultPayload === 'object'
              ? (resultPayload as Record<string, unknown>)
              : null;
          const value = record ? record.replayDigest : null;
          if (typeof value !== 'string' || value === '') {
            throw new Error('Ván này chưa có replay (kết quả không kèm replayDigest).');
          }
          replayDigest = value;
        }
        if (!replayDigest) {
          throw new Error('Thiếu mã ván hoặc digest replay.');
        }

        if (!cancelled) setState({ phase: 'loading', message: 'Đang tải tệp replay…' });
        const binaryResponse = await fetch(replayEndpoint ?? `/api/v2/replays/${encodeURIComponent(replayDigest)}`, {
          cache: 'no-store',
        });
        if (!binaryResponse.ok) {
          throw new Error(`Không tải được replay (HTTP ${binaryResponse.status}).`);
        }

        const parsed = parseReplayBinary(await binaryResponse.arrayBuffer());
        const builtFrames = buildReplayFrames(parsed.payload);
        const checksum = await verifyReplayChecksum(parsed.bytes);
        if (cancelled) return;

        setIndex(0);
        setPlaying(false);
        setState({ phase: 'ready', replay: parsed, frames: builtFrames, checksum, digest: replayDigest });
      } catch (error) {
        if (cancelled) return;
        setState({
          phase: 'error',
          message: error instanceof Error ? error.message : 'Lỗi không xác định khi tải replay.',
        });
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [gameId, digest, replayEndpoint]);

  // One timeout per frame: the delay follows the speed selector, and playback stops on the last frame.
  useEffect(() => {
    if (!playing || !frames) return;
    if (index >= lastIndex) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => setIndex((current) => Math.min(current + 1, lastIndex)), 1000 / speed);
    return () => window.clearTimeout(timer);
  }, [playing, frames, index, lastIndex, speed]);

  const togglePlay = useCallback(() => {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (index >= lastIndex) setIndex(0);
    setPlaying(true);
  }, [playing, index, lastIndex]);

  useEffect(() => {
    if (!frames) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        setPlaying(false);
        setIndex((current) => Math.min(current + 1, lastIndex));
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        setPlaying(false);
        setIndex((current) => Math.max(current - 1, 0));
      } else if (event.key === ' ') {
        event.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [frames, lastIndex, togglePlay]);

  // Keep the active ply visible while animating; the list is the only scrollable element.
  useEffect(() => {
    if (state.phase !== 'ready') return;
    document.getElementById(`replay-ply-${index}`)?.scrollIntoView({ block: 'nearest' });
  }, [index, state.phase]);

  if (state.phase === 'loading') {
    return (
      <p className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] px-4 py-8 text-center text-sm text-[var(--text-secondary)]">
        {state.message}
      </p>
    );
  }

  if (state.phase === 'error') {
    return (
      <p className="rounded-md border border-[var(--border-subtle)] bg-[var(--danger-tint)] px-4 py-4 text-sm text-[var(--danger-text)]">
        <span className="font-semibold">Không mở được replay.</span> {state.message}
      </p>
    );
  }

  const { replay, frames: built, checksum } = state;
  const payload = replay.payload;
  const frame = built ? built.frames[Math.min(index, built.frames.length - 1)] : null;
  const plyCount = payload.trace.length;
  const winnerText = payload.winner === 0 ? 'Hòa — không bên nào thắng' : sideLabel[String(payload.winner)] ?? 'Không xác định';

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {checksum.kind === 'verified' ? (
        <p className="rounded-md border border-[var(--border-subtle)] bg-[var(--success-tint)] px-4 py-3 text-sm text-[var(--success-text)]">
          <span className="font-semibold">Checksum SHA-256 khớp.</span> 32 byte cuối tệp khớp với toàn bộ phần nội dung
          phía trước, nên tệp replay nguyên vẹn như server đã phát hành.
        </p>
      ) : checksum.kind === 'mismatch' ? (
        <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--danger-tint)] px-4 py-3 text-sm text-[var(--danger-text)]">
          <p>
            <span className="font-bold">CẢNH BÁO: checksum SHA-256 KHÔNG khớp.</span> Tệp replay có thể đã hỏng hoặc
            bị sửa trên đường truyền; nội dung bên dưới chỉ để tham khảo và <span className="font-bold">không</span> được
            coi là đã xác thực.
          </p>
          <p className="mt-2 break-all font-mono text-[11px]">Checksum trong tệp: {checksum.expected}</p>
          <p className="break-all font-mono text-[11px]">SHA-256 tính lại: {checksum.actual}</p>
        </div>
      ) : (
        <p className="rounded-md border border-[var(--border-subtle)] bg-[var(--warning-tint)] px-4 py-3 text-sm text-[var(--warning-text)]">
          <span className="font-semibold">Chưa kiểm tra được checksum.</span> {checksum.reason} Nội dung replay dưới đây
          chưa được xác thực.
        </p>
      )}

      <section className="flex flex-wrap items-start justify-between gap-4 rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] px-4 py-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Replay</p>
          <h2 className="mt-1 break-all text-lg font-semibold">{payload.gameId || 'Không rõ mã ván'}</h2>
          <p className="mt-2 text-sm text-[var(--text-secondary)]">
            Bàn {payload.mapId || '—'} · luật {payload.rulesRevision || '—'} · manifest{' '}
            <span className="font-mono">{replay.manifestDigest.slice(0, 16) || '—'}</span>
          </p>
          <p className="mt-1 break-all text-xs text-[var(--text-secondary)]">
            digest replay: <span className="font-mono">{state.digest}</span>
          </p>
        </div>
        <div className="grid min-w-0 grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          <div>
            <p className="text-xs text-[var(--text-secondary)]">Kết quả</p>
            <p className="mt-1 text-lg font-semibold">{winnerText}</p>
          </div>
          <div>
            <p className="text-xs text-[var(--text-secondary)]">Lý do</p>
            <p className="mt-1 text-sm font-semibold">{winReasonLabel[payload.reason] ?? (payload.reason || '—')}</p>
            <p className="font-mono text-[11px] text-[var(--text-secondary)]">{payload.reason || '—'}</p>
          </div>
          <div>
            <p className="text-xs text-[var(--text-secondary)]">Disposition</p>
            <p className="mt-1 text-sm font-semibold">{dispositionLabel[payload.disposition] ?? (payload.disposition || '—')}</p>
            <p className="font-mono text-[11px] text-[var(--text-secondary)]">{payload.disposition || '—'}</p>
          </div>
          <div>
            <p className="text-xs text-[var(--text-secondary)]">Số lượt</p>
            <p className="mt-1 text-lg font-semibold tabular-nums">{payload.totalTurns}</p>
            <p className="text-[11px] text-[var(--text-secondary)]">{plyCount} nước trong trace</p>
          </div>
        </div>
      </section>

      {!built ? (
        <p className="rounded-md border border-[var(--border-subtle)] bg-[var(--warning-tint)] px-4 py-3 text-sm text-[var(--warning-text)]">
          Bản replay cũ không kèm bàn đấu (map descriptor) nên không thể dựng lại thế cờ — danh sách nước đi bên dưới
          vẫn là dữ liệu thật của ván.
        </p>
      ) : null}

      {built && built.warnings.length > 0 ? (
        <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--warning-tint)] px-4 py-3 text-sm text-[var(--warning-text)]">
          <p className="font-semibold">Một số nước không dựng lại được đúng như engine:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {built.warnings.slice(0, 4).map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
          {built.warnings.length > 4 ? <p className="mt-1">… và {built.warnings.length - 4} cảnh báo khác.</p> : null}
        </div>
      ) : null}

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="flex min-w-0 flex-col gap-4 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-4 sm:p-5 shadow-sm">
          {built && frame ? (
            <ReplayBoard descriptor={built.descriptor} frame={frame} />
          ) : (
            <p className="rounded-sm border border-dashed border-[var(--border-subtle)] px-4 py-12 text-center text-sm text-[var(--text-secondary)]">
              Không có bàn đấu để hiển thị cho replay này.
            </p>
          )}

          {frame?.note ? (
            <p className="rounded-sm border border-[var(--border-subtle)] bg-[var(--warning-tint)] px-3 py-2 text-xs text-[var(--warning-text)]">
              {frame.note}
            </p>
          ) : null}

          {built ? (
            <div className="flex flex-wrap items-center gap-2 border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-4 py-3 rounded-2xl shadow-sm">
              <button
                type="button"
                onClick={() => {
                  setPlaying(false);
                  setIndex(0);
                }}
                disabled={playing || index === 0}
                className="vct-btn-secondary !py-1.5 !px-3 !text-xs font-mono disabled:opacity-40"
              >
                ⏮ ĐẦU
              </button>
              <button
                type="button"
                onClick={() => {
                  setPlaying(false);
                  setIndex((current) => Math.max(current - 1, 0));
                }}
                disabled={playing || index === 0}
                className="vct-btn-secondary !py-1.5 !px-3 !text-xs font-mono disabled:opacity-40"
              >
                ◀ LÙI
              </button>
              <button
                type="button"
                onClick={togglePlay}
                disabled={lastIndex === 0}
                className="vct-btn-primary !py-1.5 !px-4 !text-xs disabled:opacity-40"
              >
                {playing ? '⏸ TẠM DỪNG' : '▶ PHÁT REPLAY'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setPlaying(false);
                  setIndex((current) => Math.min(current + 1, lastIndex));
                }}
                disabled={playing || index >= lastIndex}
                className="vct-btn-secondary !py-1.5 !px-3 !text-xs font-mono disabled:opacity-40"
              >
                TIẾN ▶
              </button>
              <button
                type="button"
                onClick={() => {
                  setPlaying(false);
                  setIndex(lastIndex);
                }}
                disabled={playing || index >= lastIndex}
                className="vct-btn-secondary !py-1.5 !px-3 !text-xs font-mono disabled:opacity-40"
              >
                CUỐI ⏭
              </button>

              <label className="flex items-center gap-2 font-mono text-xs text-[var(--text-secondary)] uppercase">
                TỐC ĐỘ:
                <select
                  value={speed}
                  onChange={(event) => setSpeed(Number(event.target.value))}
                  className="border border-[var(--border-control)] bg-[var(--surface)] px-2 py-1 font-mono text-xs text-[var(--text-primary)]"
                >
                  {SPEEDS.map((option) => (
                    <option key={option} value={option}>
                      {option}×
                    </option>
                  ))}
                </select>
              </label>

              <span className="ml-auto font-mono text-xs text-[var(--text-secondary)] uppercase tabular-nums">
                NƯỚC: <strong className="text-[var(--text-primary)]">{frame?.ply ?? 0}</strong> / {plyCount}
              </span>


              <input
                type="range"
                min={0}
                max={lastIndex}
                step={1}
                value={Math.min(index, lastIndex)}
                disabled={playing || lastIndex === 0}
                onChange={(event) => {
                  setPlaying(false);
                  setIndex(Number(event.target.value));
                }}
                aria-label="Thanh tiến trình replay"
                className="h-2 w-full min-w-[200px] flex-1 cursor-pointer accent-[var(--action)] disabled:opacity-40"
              />
            </div>
          ) : null}

          <p className="text-xs text-[var(--text-secondary)]">
            Phím tắt: ← / → để lùi hoặc tiến một nước, Space để phát hoặc tạm dừng.
          </p>
        </section>

        <aside className="flex min-w-0 max-h-[760px] flex-col overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] shadow-sm">
          <div className="border-b border-[var(--border-subtle)] px-4 py-3">
            <h2 className="text-sm font-semibold">Danh sách nước đi</h2>
            <p className="text-xs text-[var(--text-secondary)]">
              {plyCount} nước · {built ? 'bấm một dòng để xem thế cờ' : 'dữ liệu thô từ replay'}
            </p>
          </div>
          {plyCount === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-[var(--text-secondary)]">
              Replay không có nước đi nào (ván kết thúc trước khi có nước hợp lệ).
            </p>
          ) : (
            <ol className="flex-1 divide-y divide-[var(--border-subtle)] overflow-y-auto">
              {payload.trace.map((step, position) => {
                const active = built ? index === position + 1 : false;
                const capture = built?.frames[position + 1]?.captured ?? null;
                return (
                  <li key={`ply-${position}-${step.ply}`}>
                    <button
                      type="button"
                      id={`replay-ply-${position + 1}`}
                      disabled={built === null}
                      onClick={() => {
                        setPlaying(false);
                        setIndex(built ? position + 1 : 0);
                      }}
                      className={`flex w-full items-center gap-3 px-4 py-2 text-left text-xs transition ${
                        active
                          ? 'bg-[var(--surface-subtle)] text-[var(--text-primary)]'
                          : built
                            ? 'hover:bg-[var(--surface-subtle)]'
                            : 'cursor-default'
                      }`}
                    >
                      <span className="w-10 shrink-0 tabular-nums text-[var(--text-secondary)]">#{step.ply}</span>
                      <span className="w-24 shrink-0 font-semibold">
                        {sideLabel[String(step.side)] ?? `Bên ${step.side}`}
                      </span>
                      <span className="shrink-0 font-mono">
                        #{step.move.pieceId} → ({step.move.targetPos.x}, {step.move.targetPos.y})
                      </span>
                      {capture ? <span className="ml-auto shrink-0 text-[var(--danger-text)]">ăn #{capture.id}</span> : null}
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </aside>
      </div>

      <p className="text-xs text-[var(--text-secondary)]">
        <Link className="text-[var(--action)] hover:text-[var(--action-hover)]" href="/">
          ← Về danh sách giải đấu
        </Link>
      </p>
    </div>
  );
}
