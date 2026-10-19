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
  return <p className="text-xs text-[var(--text-secondary)]" aria-live="polite">Bản công bố: {publication.generationId ?? 'chưa có'} · Phiên bản {publication.activeRevision}{publication.updating && <span className="text-[var(--warning-text)]"> · Đang cập nhật; đang hiển thị bản công bố trước.</span>}</p>;
}

export function LiveLeaderboard({ initial, featured = false }: { initial: GlobalLeaderboardDto | null; featured?: boolean }) {
  const [cursor, setCursor] = useState<string | undefined>();
  const [state, load] = useRatingData<GlobalLeaderboardDto>(`/ratings/teams?limit=${featured ? 8 : 50}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, initial);
  const refresh = useCallback(async () => {
    const result = await load();
    if (result === 'stale') { setCursor(undefined); }
    return result;
  }, [load]);
  // Cursor changes must fetch immediately, not wait for the next polling interval.
  useEffect(() => { void refresh(); }, [refresh]);
  useRatingRefresh(refresh, Boolean(state.data?.publication.updating));
  const board = state.data;
  return <section className="flex flex-col gap-3"><p role="status" className="text-sm text-[var(--danger-text)]">{state.error}</p>{state.error && <button onClick={() => void refresh()}>Thử lại</button>}{board && <Publication publication={board.publication}/>}<div className="overflow-x-auto"><table className="w-full border-collapse text-left"><caption className="sr-only">Xếp hạng Rating global các đội</caption><thead><tr><th scope="col">Hạng</th><th scope="col">Đội</th><th scope="col">Rating global</th><th scope="col">Số giải</th></tr></thead><tbody>{board?.rows.map(row => <tr key={row.teamId}><td>{row.rank}</td><td><TeamRatingName teamId={row.teamId} name={row.name} rating={row.rating}/></td><td>{row.rating.rating}</td><td>{row.rating.ratedContests}</td></tr>)}</tbody></table></div>{board && board.rows.length === 0 && <p>Chưa có đội nào được xếp hạng.</p>}{!featured && <div className="flex gap-3">{cursor && <button onClick={() => setCursor(undefined)}>Trang đầu</button>}{board?.nextCursor && <button onClick={() => setCursor(board.nextCursor!)}>Trang tiếp</button>}</div>}</section>;
}

export function LiveTeamProfile({ teamId, initial }: { teamId: string; initial: PublicTeamProfileDto | null }) {
  const [cursor, setCursor] = useState<string | undefined>();
  const [state, load] = useRatingData<PublicTeamProfileDto>(`/ratings/teams/${encodeURIComponent(teamId)}?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, initial);
  const profile = state.data;
  const refresh = useCallback(async () => {
    const result = await load();
    if (result === 'stale') setCursor(undefined);
    // A generation change returns RATING_PAGE_STALE for every non-first page.
    // Restart instead of merging pages from different immutable generations.
    return result;
  }, [load]);
  useEffect(() => { void refresh(); }, [refresh]);
  useRatingRefresh(refresh, Boolean(profile?.publication.updating));
  if (!profile) return <section><p role="alert">{state.error ?? 'Đang tải hồ sơ rating…'}</p><button onClick={() => void refresh()}>Thử lại</button></section>;
  return <section className="flex flex-col gap-4"><h2 className="font-semibold"><TeamRatingName teamId={teamId} name={profile.name} rating={profile.rating}/></h2><p role="status" className="text-[var(--danger-text)]">{state.error}</p>{state.error && <button onClick={() => void refresh()}>Thử lại</button>}<Publication publication={profile.publication}/><p>Rating global: {profile.rating.rating ?? 'Unrated'} · Cao nhất: {profile.rating.maxRating ?? '—'} · {profile.rating.ratedContests} giải <RatingBadge rating={profile.rating}/></p><RatingHistoryChart points={profile.ratingPoints.map(point => ({ ...point, newRating: point.rating }))}/><div className="overflow-x-auto"><table className="w-full text-left"><caption>Lịch sử công bố (25 giải mỗi trang)</caption><thead><tr><th scope="col">Giải</th><th scope="col">Hạng</th><th scope="col">Cũ</th><th scope="col">Δ</th><th scope="col">Mới</th></tr></thead><tbody>{profile.history.map(row => <tr key={`${row.tournamentId}:${row.publicationOrder}`}><td><Link href={`/tournaments/${row.tournamentId}`}>{row.tournamentName}</Link></td><td>{row.rank}{row.rankEnd > row.rank ? `–${row.rankEnd}` : ''}</td><td>{row.oldPublicRating === null ? 'Unrated (1500 hiệu dụng)' : row.oldRating}</td><td>{row.delta > 0 ? '+' : ''}{row.delta}</td><td>{row.newRating}</td></tr>)}</tbody></table></div>{profile.rating.ratedContests === 0 && <p>Đội chưa có giải tính Rating global được công bố.</p>}<div className="flex gap-3">{cursor && <button onClick={() => setCursor(undefined)}>Trang đầu</button>}{profile.nextCursor && <button onClick={() => setCursor(profile.nextCursor!)}>Trang tiếp</button>}</div></section>;
}

