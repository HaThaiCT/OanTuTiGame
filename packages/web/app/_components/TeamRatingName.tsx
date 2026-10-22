'use client';

import Link from 'next/link';
import type { RatingChangeDto, TeamRatingSummary } from '@oantuti/protocol';
import { useContext } from 'react';
import { RatingContext } from './rating-context';

export function RatingBadge({ rating }: { readonly rating: TeamRatingSummary }) {
  if (!rating || rating.rank === 'UNRATED' || rating.rating === null || rating.rating === undefined || rating.ratedContests === 0) return null;
  return (
    <span
      className={`rating-badge rating-${rating.rank.toLowerCase()} font-mono font-bold text-[10px] px-2 py-0.5 rounded-full border border-current shadow-xs`}
    >
      {rating.rating}
    </span>
  );
}

export function TeamRatingName({ teamId, name, rating, compact = false }: { readonly teamId: string; readonly name: string; readonly rating: TeamRatingSummary | null; readonly compact?: boolean }) {
  const publishedTeam = useContext(RatingContext)?.teams.find(team => team.teamId === teamId);
  rating = publishedTeam?.rating ?? rating;
  name = publishedTeam?.name ?? name;
  const isUnrated = !rating || rating.rank === 'UNRATED' || rating.rating === null || rating.rating === undefined || rating.ratedContests === 0;
  const ratingValue = isUnrated || !rating ? 0 : rating.rating;
  const label = `${name} (Rating: ${ratingValue})`;
  return (
    <span className={`rating-name${!isUnrated && rating ? ` rating-${rating.rank.toLowerCase()}` : ' rating-unrated'}`}>
      <Link href={`/teams/${encodeURIComponent(teamId)}`} title={label} aria-label={label}>
        {name}
      </Link>
    </span>
  );
}

export { default as RatingHistoryChart } from './RatingHistoryChart';
