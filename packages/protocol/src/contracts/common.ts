export type UUID = string;
export type Digest = string; // SHA-256 hex
export type Instant = string; // ISO-8601 UTC timestamp

export type Role = 'ADMIN' | 'STUDENT' | 'OPERATOR';
export type SessionScope = 'FULL' | 'PASSWORD_CHANGE_ONLY';
export type DeploymentProfile = 'LAN_OFFLINE' | 'ONLINE';

export interface Actor {
  readonly userId: UUID;
  readonly role: Role;
  readonly username: string;
  readonly teamIds: readonly UUID[];
  readonly scope: SessionScope;
}

export interface CommandContext {
  readonly actor: Actor;
  readonly expectedVersion?: number;
  readonly idempotencyKey?: string;
  readonly requestId: UUID;
}

export interface Receipt<T> {
  readonly receiptId: UUID;
  readonly timestamp: Instant;
  readonly data: T;
}
