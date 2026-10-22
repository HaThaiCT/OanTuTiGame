import type { Digest, Instant, UUID } from './common.js';
import type { BotLanguage } from './submissions.js';

export interface NewsPostDto {
  readonly id: UUID;
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly content: string;
  readonly publishedAt: Instant | null;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
}

export interface AdminNewsPostDto extends NewsPostDto {
  readonly state: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  readonly authorUserId: UUID;
  readonly authorDisplayName?: string;
}

export interface StarterBotTemplateDto {
  readonly id: UUID;
  readonly slug: string;
  readonly name: string;
  readonly language: BotLanguage;
  readonly entrypoint: string;
  readonly description: string | null;
  readonly sourceDigest: Digest;
  readonly version: number;
  readonly isActive: boolean;
  readonly createdAt: Instant;
}
