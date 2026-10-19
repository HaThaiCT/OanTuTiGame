'use client';

import { useEffect } from 'react';
import type { TournamentRatingChangesDto } from '@oantuti/protocol';
import { useRatingData, useRatingRefresh } from '../../_components/RatingLivePanels';
import { TeamRatingName } from '../../_components/TeamRatingName';

export default function RatingStatus({ tournamentId, isRated }: { tournamentId: string; isRated: boolean }) {
  const [state, load] = useRatingData<TournamentRatingChangesDto>(`/tournaments/${encodeURIComponent(tournamentId)}/rating-changes`, null);
  useEffect(() => { void load(); }, [load]);
  useRatingRefresh(load, Boolean(state.data?.publication.updating));
  const data = state.data;
  return <section className="rounded-md border border-[var(--border-subtle)] p-4"><h2 className="font-semibold">Công bố Rating global</h2><p role="status">{state.error}</p>{state.error && <button onClick={() => void load()}>Thử lại</button>}<p>{isRated ? 'Rated' : 'Unrated'} · {data?.reviewState === 'REJECTED' ? 'Rating rejected — Đã từ chối tính rating' : data?.reviewState ?? 'Đang tải'} · {data?.policy ?? 'ArenaContestRating/v1'}</p>{data?.publication.updating && <p className="text-[var(--warning-text)]">Đang cập nhật; đang hiển thị bản công bố trước.</p>}{data && <p className="text-xs text-[var(--text-secondary)]">Bản công bố {data.publication.generationId ?? 'chưa có'} · Phiên bản {data.publication.activeRevision}</p>}{data && data.changes.length > 0 && <div className="overflow-x-auto"><table className="w-full text-left"><caption>Thay đổi đã công bố của giải này</caption><thead><tr><th scope="col">Đội</th><th scope="col">Hạng</th><th scope="col">Cũ</th><th scope="col">Δ</th><th scope="col">Mới</th></tr></thead><tbody>{data.changes.map(change => <tr key={change.teamId}><td><TeamRatingName teamId={change.teamId} name={change.teamId} rating={null}/></td><td>{change.rank}{change.rankEnd > change.rank ? `–${change.rankEnd}` : ''}</td><td>{change.oldPublicRating ?? 'Unrated'}</td><td>{change.delta > 0 ? '+' : ''}{change.delta}</td><td>{change.newRating}</td></tr>)}</tbody></table></div>}</section>;
}
