import type { Instant, UUID } from './common.js';

export type TeamRatingRank =
  | 'UNRATED' | 'NEWBIE' | 'PUPIL' | 'SPECIALIST' | 'EXPERT'
  | 'CANDIDATE_MASTER' | 'MASTER' | 'INTERNATIONAL_MASTER' | 'GRANDMASTER'
  | 'INTERNATIONAL_GRANDMASTER' | 'LEGENDARY_GRANDMASTER';

export interface TeamRatingSummary {
  readonly rating: number | null;
  readonly maxRating: number | null;
  readonly ratedContests: number;
  readonly rank: TeamRatingRank;
}

export interface RatingPublicationMeta {
  readonly generationId: string | null;
  readonly activeRevision: string;
  readonly desiredRevision: string;
  readonly updating: boolean;
}

export interface ContestPlacement {
  readonly teamId: UUID;
  readonly rank: number;
  readonly rankEnd: number;
  readonly participation: 'PLACED' | 'WITHDRAWN';
}

export interface RatingChangeDto {
  readonly teamId: UUID;
  readonly tournamentId: UUID;
  readonly tournamentName: string;
  readonly publicationOrder: string;
  readonly inputRevision: number;
  readonly rank: number;
  readonly rankEnd: number;
  readonly participantCount: number;
  readonly oldRating: number;
  readonly oldPublicRating: number | null;
  readonly delta: number;
  readonly newRating: number;
  readonly policy: 'ArenaContestRating/v1';
}

export interface RatingReviewDto {
  readonly tournamentId: UUID;
  readonly tournamentVersion: number;
  readonly isRated: boolean;
  readonly status: 'UNRATED' | 'NOT_FINAL' | 'PENDING' | 'BLOCKED' | 'APPROVED' | 'REJECTED';
  readonly reason: string | null;
  readonly generationId: string | null;
  readonly desiredRevision: string;
  readonly sourceDigest: string | null;
  readonly previewDigest: string | null;
  readonly placements: readonly ContestPlacement[];
  readonly changes: readonly RatingChangeDto[];
  readonly publicationOrder: string | null;
  readonly affectedContestCount: number;
  readonly updating: boolean;
  readonly exclusions: readonly { readonly teamId: UUID; readonly reason: 'PRESTART_EXCLUDED' | 'WITHDRAWN' | 'DISQUALIFIED' }[];
}

export interface RatingDecisionReceipt {
  readonly receiptId: UUID;
  readonly tournamentId: UUID;
  readonly desiredRevision: string;
  readonly tournamentVersion: number;
  readonly status: 'UPDATING' | 'REJECTED';
}

export interface PublicTeamProfileDto {
  readonly teamId: UUID;
  readonly name: string;
  readonly rating: TeamRatingSummary;
  readonly publication: RatingPublicationMeta;
  readonly history: readonly RatingChangeDto[];
  readonly ratingPoints: readonly { readonly publicationOrder: string; readonly rating: number; readonly tournamentName: string }[];
  readonly nextCursor: string | null;
}

export interface GlobalLeaderboardDto {
  readonly publication: RatingPublicationMeta;
  readonly rows: readonly { readonly teamId: UUID; readonly name: string; readonly rank: number; readonly rating: TeamRatingSummary }[];
  readonly nextCursor: string | null;
}

export interface TournamentRatingChangesDto {
  readonly tournamentId: UUID;
  readonly isRated: boolean;
  readonly policy: 'ArenaContestRating/v1';
  readonly reviewState: 'UNRATED' | 'NOT_FINAL' | 'PENDING' | 'APPROVED' | 'REJECTED';
  readonly publication: RatingPublicationMeta;
  readonly changes: readonly RatingChangeDto[];
}

export interface TournamentTeamRatingsDto {
  readonly publication: RatingPublicationMeta;
  readonly teams: readonly { readonly teamId: UUID; readonly name: string; readonly rating: TeamRatingSummary }[];
}

export interface RatingDecisionAudit {
  readonly createdAt: Instant;
}
