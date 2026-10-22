'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GlobalLeaderboardDto, PublicTeamProfileDto } from '@oantuti/protocol';
import { RatingBadge, RatingHistoryChart, TeamRatingName } from './TeamRatingName';

/** One request owns one complete generation dataset; obsolete requests never replace it. */
export function useRatingData<T>(path: string, initial: T | null) {
  const [state, setState] = useState<{ data: T | null; error: string | null }>({ data: initial, error: null });
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    if (!path || document.hidden) return null;
    const sequence = ++request.current;
    controller.current?.abort();
    const active = new AbortController();
    controller.current = active;
    try {
      const response = await fetch(`/api/v2${path}`, { cache: 'no-store', signal: active.signal });
      if (response.status === 409) {
        const body = await response.json().catch(() => null);
        if (body?.code === 'RATING_PAGE_STALE' && sequence === request.current && !active.signal.aborted) return 'stale' as const;
      }
      if (!response.ok) throw new Error(`Không tải được dữ liệu rating (HTTP ${response.status}).`);
      const data = await response.json() as T;
      if (sequence !== request.current || active.signal.aborted) return null;
      setState({ data, error: null });
      return data;
    } catch (error) {
      if (sequence === request.current && !active.signal.aborted) setState(current => ({ ...current, error: error instanceof Error ? error.message : 'Không kết nối được API rating.' }));
      return null;
    }
  }, [path]);
  useEffect(() => () => { ++request.current; controller.current?.abort(); }, [path]);
  return [state, load] as const;
}

export function useRatingRefresh(load: () => Promise<unknown>, updating: boolean) {
  useEffect(() => {
    let timer: number | undefined;
    let stopped = false;
    const schedule = () => {
      if (!stopped && !document.hidden) timer = window.setTimeout(async () => { await load(); schedule(); }, updating ? 5000 : 60000);
    };
    const visibility = () => { clearTimeout(timer); if (!document.hidden) void load().then(schedule); };
    document.addEventListener('visibilitychange', visibility);
    schedule();
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [load, updating]);
}

function Publication({ publication }: { publication: GlobalLeaderboardDto['publication'] }) {
  return (
    <div className="flex items-center gap-2 font-mono text-[11px] text-[var(--text-secondary)]" aria-live="polite">
      <span>
        Bản công bố: {publication.generationId ?? 'mới nhất'} · Phiên bản {publication.activeRevision}
      </span>
      {publication.updating && (
        <span className="text-[var(--warning-text)]">
          ● Đang cập nhật
        </span>
      )}
    </div>
  );
}

export function LiveLeaderboard({ initial, featured = false }: { initial: GlobalLeaderboardDto | null; featured?: boolean }) {
  const [cursor, setCursor] = useState<string | undefined>();
  const [state, load] = useRatingData<GlobalLeaderboardDto>(
    `/ratings/teams?limit=${featured ? 8 : 50}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    initial,
  );
  const refresh = useCallback(async () => {
    const result = await load();
    if (result === 'stale') {
      setCursor(undefined);
    }
    return result;
  }, [load]);

  // Cursor changes must fetch immediately, not wait for the next polling interval.
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useRatingRefresh(refresh, Boolean(state.data?.publication.updating));
  const board = state.data;

  return (
    <section className="flex flex-col gap-3">
      {state.error && (
        <div className="flex items-center justify-between p-2.5 bg-[var(--danger-tint)] border-l-2 border-[var(--danger-text)]">
          <p role="status" className="text-xs font-mono text-[var(--danger-text)]">
            {state.error}
          </p>
          <button
            type="button"
            className="vct-btn-secondary !py-1 !px-2.5 !text-[11px]"
            onClick={() => void refresh()}
          >
            THỬ LẠI
          </button>
        </div>
      )}
      {board && <Publication publication={board.publication} />}
      <div className={`overflow-x-auto ${featured ? 'border-0 shadow-none' : 'border border-[var(--border-subtle)] shadow-xs'} bg-[var(--surface)] rounded-xl overflow-hidden`}>
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">Xếp hạng Rating global các đội</caption>
          <thead>
            <tr>
              <th scope="col" className="p-2.5 font-heading text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)] bg-[var(--surface-subtle)] border-b border-[var(--border-subtle)] w-16">
                HẠNG
              </th>
              <th scope="col" className="p-2.5 font-heading text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)] bg-[var(--surface-subtle)] border-b border-[var(--border-subtle)]">
                CHIẾN ĐỘI
              </th>
              <th scope="col" className="p-2.5 font-heading text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)] bg-[var(--surface-subtle)] border-b border-[var(--border-subtle)] text-right">
                RATING
              </th>
              <th scope="col" className="p-2.5 font-heading text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)] bg-[var(--surface-subtle)] border-b border-[var(--border-subtle)] text-right w-20">
                SỐ GIẢI
              </th>
            </tr>
          </thead>
          <tbody>
            {board?.rows.map(row => {
              const rankText = String(row.rank).padStart(2, '0');
              return (
                <tr key={row.teamId} className="hover:bg-[var(--surface-subtle)] transition-colors">
                  <td className="p-2.5 border-b border-[var(--border-subtle)]">
                    {row.rank === 1 ? (
                      <span className="font-mono font-black text-[var(--action)]">#{rankText}</span>
                    ) : row.rank === 2 ? (
                      <span className="font-mono font-black text-[#f5a524]">#{rankText}</span>
                    ) : row.rank === 3 ? (
                      <span className="font-mono font-bold text-[var(--text-primary)]">#{rankText}</span>
                    ) : (
                      <span className="font-mono text-[var(--text-secondary)]">#{rankText}</span>
                    )}
                  </td>
                  <td className="p-2.5 border-b border-[var(--border-subtle)] font-medium">
                    <TeamRatingName teamId={row.teamId} name={row.name} rating={row.rating} />
                  </td>
                  <td className="p-2.5 border-b border-[var(--border-subtle)] font-mono font-bold text-right text-[var(--text-primary)]">
                    {row.rating.rating}
                  </td>
                  <td className="p-2.5 border-b border-[var(--border-subtle)] font-mono text-right text-[var(--text-secondary)]">
                    {row.rating.ratedContests}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {board && board.rows.length === 0 && (
        <p className="p-4 text-center text-xs text-[var(--text-secondary)]">
          Chưa có đội nào được xếp hạng.
        </p>
      )}
      {!featured && (
        <div className="flex items-center gap-3 pt-2">
          {cursor && (
            <button
              type="button"
              className="vct-btn-secondary !py-1 !px-3.5 !text-xs !rounded-full"
              onClick={() => setCursor(undefined)}
            >
              Trang đầu
            </button>
          )}
          {board?.nextCursor && (
            <button
              type="button"
              className="vct-btn-secondary !py-1 !px-3.5 !text-xs !rounded-full"
              onClick={() => setCursor(board.nextCursor!)}
            >
              Trang tiếp
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export function LiveTeamProfile({ teamId, initial }: { teamId: string; initial: PublicTeamProfileDto | null }) {
  const [cursor, setCursor] = useState<string | undefined>();
  const [state, load] = useRatingData<PublicTeamProfileDto>(
    `/ratings/teams/${encodeURIComponent(teamId)}?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    initial,
  );
  const profile = state.data;
  const refresh = useCallback(async () => {
    const result = await load();
    if (result === 'stale') setCursor(undefined);
    return result;
  }, [load]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useRatingRefresh(refresh, Boolean(profile?.publication.updating));

  if (!profile) {
    return (
      <section className="p-4 border border-[var(--border-subtle)] bg-[var(--surface)]">
        <p role="alert" className="text-xs text-[var(--text-secondary)]">
          {state.error ?? 'Đang tải hồ sơ đội...'}
        </p>
        {state.error && (
          <button
            type="button"
            className="vct-btn-secondary !py-1 !px-3 !text-xs mt-3"
            onClick={() => void refresh()}
          >
            THỬ LẠI
          </button>
        )}
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="p-5 border border-[var(--border-subtle)] bg-[var(--surface)] rounded-2xl shadow-sm">
        <h2 className="font-heading text-xl font-bold uppercase tracking-wider flex items-center gap-2">
          <TeamRatingName teamId={teamId} name={profile.name} rating={profile.rating} />
        </h2>
        {state.error && (
          <div className="mt-2 text-xs font-mono text-[var(--danger-text)]">
            {state.error}
          </div>
        )}
        <div className="mt-3">
          <Publication publication={profile.publication} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-4 font-mono text-xs text-[var(--text-secondary)]">
          <span>
            RATING GLOBAL:{' '}
            <strong className="text-[var(--text-primary)] font-bold">
              {profile.rating.rating ?? 'UNRATED'}
            </strong>
          </span>
          <span>·</span>
          <span>
            CAO NHẤT:{' '}
            <strong className="text-[var(--text-primary)] font-bold">
              {profile.rating.maxRating ?? '—'}
            </strong>
          </span>
          <span>·</span>
          <span>{profile.rating.ratedContests} GIẢI ĐẤU</span>
        </div>
      </div>

      <RatingHistoryChart
        points={profile.ratingPoints.map(point => ({ ...point, newRating: point.rating }))}
      />

      <div className="overflow-x-auto border border-[var(--border-subtle)] bg-[var(--surface)] rounded-xl overflow-hidden shadow-xs">
        <table className="w-full text-left border-collapse">
          <caption className="p-2.5 font-heading text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)] bg-[var(--surface-subtle)] border-b border-[var(--border-subtle)] text-left">
            LỊCH SỬ CÔNG BỐ (25 GIẢI MỖI TRANG)
          </caption>
          <thead>
            <tr>
              <th scope="col" className="p-2.5 font-heading text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)] bg-[var(--surface-subtle)] border-b border-[var(--border-subtle)]">
                GIẢI ĐẤU
              </th>
              <th scope="col" className="p-2.5 font-heading text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)] bg-[var(--surface-subtle)] border-b border-[var(--border-subtle)]">
                HẠNG
              </th>
              <th scope="col" className="p-2.5 font-heading text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)] bg-[var(--surface-subtle)] border-b border-[var(--border-subtle)] font-mono">
                CŨ
              </th>
              <th scope="col" className="p-2.5 font-heading text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)] bg-[var(--surface-subtle)] border-b border-[var(--border-subtle)] font-mono">
                Δ
              </th>
              <th scope="col" className="p-2.5 font-heading text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)] bg-[var(--surface-subtle)] border-b border-[var(--border-subtle)] font-mono">
                MỚI
              </th>
            </tr>
          </thead>
          <tbody>
            {profile.history.map(row => (
              <tr key={`${row.tournamentId}:${row.publicationOrder}`} className="hover:bg-[var(--surface-subtle)] transition-colors">
                <td className="p-2.5 border-b border-[var(--border-subtle)] font-medium">
                  <Link href={`/tournaments/${row.tournamentId}`} className="hover:text-[var(--action)] underline decoration-[var(--border-control)]">
                    {row.tournamentName}
                  </Link>
                </td>
                <td className="p-2.5 border-b border-[var(--border-subtle)] font-mono">
                  #{row.rank}
                  {row.rankEnd > row.rank ? `–#${row.rankEnd}` : ''}
                </td>
                <td className="p-2.5 border-b border-[var(--border-subtle)] font-mono text-[var(--text-secondary)]">
                  {row.oldPublicRating === null ? 'UNRATED' : row.oldRating}
                </td>
                <td className="p-2.5 border-b border-[var(--border-subtle)] font-mono font-bold">
                  {row.delta > 0 ? (
                    <span className="text-[var(--success-text)]">+{row.delta}</span>
                  ) : row.delta < 0 ? (
                    <span className="text-[var(--danger-text)]">{row.delta}</span>
                  ) : (
                    <span className="text-[var(--text-secondary)]">0</span>
                  )}
                </td>
                <td className="p-2.5 border-b border-[var(--border-subtle)] font-mono font-bold text-[var(--text-primary)]">
                  {row.newRating}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {profile.rating.ratedContests === 0 && (
        <p className="p-4 text-center text-xs text-[var(--text-secondary)] border border-[var(--border-subtle)] rounded-xl">
          Đội chưa có giải đấu tính rating được công bố.
        </p>
      )}

      <div className="flex items-center gap-3 pt-2">
        {cursor && (
          <button
            type="button"
            className="vct-btn-secondary !py-1 !px-3 !text-xs"
            onClick={() => setCursor(undefined)}
          >
            ◄ TRANG ĐẦU
          </button>
        )}
        {profile.nextCursor && (
          <button
            type="button"
            className="vct-btn-secondary !py-1 !px-3 !text-xs"
            onClick={() => setCursor(profile.nextCursor!)}
          >
            TRANG TIẾP ►
          </button>
        )}
      </div>
    </section>
  );
}

