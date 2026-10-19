'use client';

import Link from 'next/link';
import type { RatingChangeDto, TeamRatingSummary } from '@oantuti/protocol';
import { useContext } from 'react';
import { RatingContext } from './rating-context';

const RANK_LABEL: Record<TeamRatingSummary['rank'], string> = {
  UNRATED: 'Chưa xếp hạng', NEWBIE: 'Newbie', PUPIL: 'Pupil', SPECIALIST: 'Specialist', EXPERT: 'Expert',
  CANDIDATE_MASTER: 'Candidate Master', MASTER: 'Master', INTERNATIONAL_MASTER: 'International Master',
  GRANDMASTER: 'Grandmaster', INTERNATIONAL_GRANDMASTER: 'International Grandmaster', LEGENDARY_GRANDMASTER: 'Legendary Grandmaster',
};

export function RatingBadge({ rating }: { readonly rating: TeamRatingSummary }) {
  return <span className={`rating-badge rating-${rating.rank.toLowerCase()}`} title={RANK_LABEL[rating.rank]}>{rating.rank === 'UNRATED' ? 'Unrated' : `${RANK_LABEL[rating.rank]} · ${rating.rating}`}</span>;
}

export function TeamRatingName({ teamId, name, rating, compact = false }: { readonly teamId: string; readonly name: string; readonly rating: TeamRatingSummary | null; readonly compact?: boolean }) {
  const publishedTeam = useContext(RatingContext)?.teams.find(team => team.teamId === teamId);
  rating = publishedTeam?.rating ?? rating;
  name = publishedTeam?.name ?? name;
  const label = rating ? `${name} — ${RANK_LABEL[rating.rank]}${rating.rating === null ? '' : `, ${rating.rating}`}` : `${name} — Rating global đang tải hoặc không khả dụng`;
  return <span className={`rating-name${rating ? ` rating-${rating.rank.toLowerCase()}` : ''}`}><Link href={`/teams/${encodeURIComponent(teamId)}`} title={label} aria-label={label}>{name}</Link>{rating && !compact ? <RatingBadge rating={rating} /> : null}</span>;
}

export function RatingHistoryChart({ points }: { readonly points: readonly Pick<RatingChangeDto, 'publicationOrder' | 'newRating' | 'tournamentName'>[] }) {
  points = [...points].sort((a, b) => BigInt(a.publicationOrder) < BigInt(b.publicationOrder) ? -1 : BigInt(a.publicationOrder) > BigInt(b.publicationOrder) ? 1 : 0);
  if (points.length === 0) return <p className="text-sm text-[var(--text-secondary)]">Chưa có lịch sử rating công bố.</p>;
  const values = points.map((point) => point.newRating);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = Math.max(1, high - low);
  const polyline = points.map((point, index) => `${points.length === 1 ? 50 : (index / (points.length - 1)) * 100},${90 - ((point.newRating - low) / span) * 80}`).join(' ');
  return <div className="rating-history"><svg viewBox="0 0 100 100" role="img" aria-label="Biểu đồ lịch sử rating; số liệu đầy đủ trong bảng bên dưới"><polyline points={polyline} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />{points.length === 1 && <circle cx="50" cy="90" r="2" fill="currentColor"/>}</svg><details><summary>Bảng số liệu đầy đủ của biểu đồ</summary><table className="w-full text-left"><caption>Lịch sử Rating global theo thứ tự công bố</caption><thead><tr><th scope="col">Thứ tự</th><th scope="col">Giải</th><th scope="col">Rating</th></tr></thead><tbody>{points.map((point) => <tr key={point.publicationOrder}><td>{point.publicationOrder}</td><td>{point.tournamentName}</td><td>{point.newRating}</td></tr>)}</tbody></table></details></div>;
}
