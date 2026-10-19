import type { TeamRatingRank } from './contracts/ratings.js';

export function teamRatingRank(rating: number | null): TeamRatingRank {
  if (rating === null) return 'UNRATED';
  if (!Number.isInteger(rating) || rating < 0 || rating > 8000) throw new Error('INVALID_TEAM_RATING');
  if (rating < 1200) return 'NEWBIE';
  if (rating < 1400) return 'PUPIL';
  if (rating < 1600) return 'SPECIALIST';
  if (rating < 1900) return 'EXPERT';
  if (rating < 2100) return 'CANDIDATE_MASTER';
  if (rating < 2300) return 'MASTER';
  if (rating < 2400) return 'INTERNATIONAL_MASTER';
  if (rating < 2600) return 'GRANDMASTER';
  if (rating < 3000) return 'INTERNATIONAL_GRANDMASTER';
  return 'LEGENDARY_GRANDMASTER';
}
