'use client';

import { useEffect, type ReactNode } from 'react';
import type { TournamentTeamRatingsDto } from '@oantuti/protocol';
import { useRatingData, useRatingRefresh } from './RatingLivePanels';
import { RatingContext } from './rating-context';

export function TournamentRatingProvider({ tournamentId, initial = null, children }: { tournamentId: string; initial?: TournamentTeamRatingsDto | null; children: ReactNode }) {
  const [state, load] = useRatingData<TournamentTeamRatingsDto>(tournamentId ? `/tournaments/${encodeURIComponent(tournamentId)}/team-ratings` : '', initial);
  useEffect(() => { if (tournamentId) void load(); }, [load, tournamentId]);
  useRatingRefresh(load, Boolean(state.data?.publication.updating));
  return <RatingContext.Provider value={state.data}><p role="status" className="text-sm text-[var(--danger-text)]">{state.error}</p>{state.data?.publication.updating && <p role="status" className="text-sm text-[var(--warning-text)]">Đang cập nhật; đang hiển thị bản công bố trước.</p>}{children}</RatingContext.Provider>;
}
