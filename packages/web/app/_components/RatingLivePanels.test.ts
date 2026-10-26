import { describe, expect, it } from 'vitest';
import { historyOldRatingDisplay } from './RatingLivePanels';

describe('historyOldRatingDisplay', () => {
  it('shows the previous rating when it publicly existed', () => {
    expect(historyOldRatingDisplay({ oldRating: 1612, oldPublicRating: 1612 })).toBe(1612);
    expect(historyOldRatingDisplay({ oldRating: 1491, oldPublicRating: 1500 })).toBe(1491);
  });

  it('renders — for a first-rated contest instead of an arithmetically wrong 0', () => {
    // Regression: the old cell rendered `0` for `oldPublicRating === null`, printing
    // "CŨ=0, MỚI=1612, Δ=+112" where 0 ≠ 1612−Δ — a number that never existed.
    expect(historyOldRatingDisplay({ oldRating: 1500, oldPublicRating: null })).toBe('—');
    expect(historyOldRatingDisplay({ oldRating: 1612, oldPublicRating: null })).toBe('—');
  });
});
