import type { Actor, CommandContext, Instant, Receipt, Role, SessionScope, UUID } from './common.js';

export interface UserDto {
  readonly id: UUID;
  readonly username: string;
  readonly displayName: string;
  readonly role: Role;
  readonly email?: string;
  readonly passwordChangeRequired: boolean;
  readonly createdAt: Instant;
}

export interface SessionDto {
  readonly sessionId: UUID;
  readonly token: string;
  readonly user: UserDto;
  readonly scope: SessionScope;
  readonly expiresAt: Instant;
}

export interface LanBulkUserEntry {
  readonly username: string;
  readonly displayName: string;
  readonly role: Role;
}

export interface LanProvisionedUser {
  readonly userId: UUID;
  readonly username: string;
  readonly displayName: string;
  readonly temporaryPassword: string;
}

export interface TeamDto {
  readonly id: UUID;
  readonly courseId: UUID;
  readonly name: string;
  readonly captainUserId: UUID;
  readonly tournamentId?: UUID;
  readonly closedAt?: Instant;
  readonly rosterLocked?: boolean;
  readonly members: readonly {
    readonly userId: UUID;
    readonly username: string;
    readonly displayName: string;
    readonly role: 'CAPTAIN' | 'MEMBER';
  }[];
  readonly createdAt: Instant;
}

export interface TeamInvitationDto {
  readonly id: UUID;
  readonly teamId: UUID;
  readonly teamName: string;
  readonly tournamentId: UUID;
  readonly recipientUserId: UUID;
  readonly status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'REVOKED';
  readonly expiresAt: Instant;
  readonly createdAt: Instant;
}

export interface TournamentSubstrateDto {
  readonly id: UUID;
  readonly courseId: UUID;
  readonly name: string;
  readonly format: 'SINGLE_ELIMINATION' | 'SWISS_PLAYOFF' | 'ROUND_ROBIN' | 'ELO_ARENA';
  readonly state: 'DRAFT' | 'PUBLISHED' | 'REGISTRATION_OPEN' | 'VALIDATING_SUBMISSIONS' | 'LOCKED' | 'READY_TO_START' | 'RUNNING' | 'PAUSED' | 'PROVISIONAL' | 'FINALIZED' | 'ARCHIVED' | 'CANCELLED';
  readonly isRated: boolean;
  readonly globalRatingPolicy: 'ArenaContestRating/v1';
  readonly version: number;
  readonly rulesRevision: string;
  readonly maxTeams: number;
  readonly minTeamSize: number;
  readonly maxTeamSize: number;
  readonly registrationOpensAt?: Instant;
  readonly registrationClosesAt?: Instant;
  readonly admittedTeamCount: number;
  readonly createdAt: Instant;
}
