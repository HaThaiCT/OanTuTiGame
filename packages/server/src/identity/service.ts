import type { Database } from '../persistence/db.js';
import type { PoolClient } from 'pg';
import { hashPassword, verifyPassword, generateToken, generateTemporaryPassword, hashToken, validPassword, needsPasswordRehash } from './crypto.js';
import type { Actor, Instant, Role, SessionScope, UUID } from '@oantuti/protocol';
import type { LanBulkUserEntry, LanProvisionedUser, SessionDto, UserDto } from '@oantuti/protocol';

import { enqueueIdentityMail, type IdentityMailOptions } from './mail-outbox.js';
export class IdentityError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    /** Optional machine-readable discriminator surfaced by the HTTP layer. */
    readonly code?: string,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = 'IdentityError';
  }
}

/**
 * Deployment authentication profile. `LAN_OFFLINE` (the default) keeps the
 * admin-issued/offline flows only; `ONLINE` enables self-registration, email
 * verification, e-mail recovery and shared tournament entry codes.
 */
export type AuthProfile = 'LAN_OFFLINE' | 'ONLINE';

interface UserRow {
  readonly id: string;
  readonly username: string;
  readonly display_name: string;
  readonly email: string | null;
  password_hash: string;
  readonly role: Role;
  readonly activation_method: string;
  readonly password_change_required: boolean;
  readonly temporary_password_expires_at: Date | null;
  readonly temporary_password_consumed_at: Date | null;
  readonly created_at: Date;
}

interface SessionRow {
  readonly id: string;
  readonly user_id: string;
  readonly token_hash: string;
  readonly scope: SessionScope;
  readonly expires_at: Date;
  readonly created_at: Date;
  readonly revoked_at: Date | null;
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
/**
 * How long a password confirmation (migration 016) stays valid for the destructive organizer routes.
 * Kept as a SQL interval because the comparison runs on the database clock — the app never mixes its
 * own clock into the decision.
 */
const REAUTH_WINDOW_SQL = "INTERVAL '10 minutes'";
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RATE_LIMIT_ACCOUNT = 3;
const RATE_LIMIT_IP = 20;
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
export interface RegistrationInput {
  readonly username: string;
  readonly displayName: string;
  readonly email: string;
  readonly password: string;
}

export interface RegistrationResult {
  readonly user: UserDto;
  readonly emailVerificationRequired: true;
}

/** `POST /api/v2/auth/reauth` answer: when the confirmation stops being accepted. */
export interface ReauthReceipt {
  readonly reauthenticatedUntil: string;
}

export class IdentityService {
  /**
   * Resolved when the service is built (the server builds exactly one), so a
   * running deployment can never flip its authentication profile mid-flight.
   */
  readonly authProfile: AuthProfile;

  constructor(private readonly db: Database, authProfile?: AuthProfile, private readonly options: { readonly mail?: IdentityMailOptions } = {}) {
    this.authProfile = authProfile ?? (process.env.OANTUTI_AUTH_PROFILE?.trim().toUpperCase() === 'ONLINE' ? 'ONLINE' : 'LAN_OFFLINE');
  }

  private requireMail(): IdentityMailOptions {
    if (!this.options.mail) throw new IdentityError(503, 'Identity mail delivery is unavailable', 'MAIL_DELIVERY_UNAVAILABLE');
    return this.options.mail;
  }

  async bootstrapAdmin(username: string, password: string, email?: string, initialAccountCapacity?: number): Promise<UserDto> {
    if (this.authProfile === 'ONLINE' && !email) throw new IdentityError(400, 'An ADMIN email address is required in ONLINE', 'INVALID_EMAIL');
    const normalizedEmail = email?.trim().toLowerCase();
    if (normalizedEmail && (normalizedEmail.length > 254 || !EMAIL_PATTERN.test(normalizedEmail))) throw new IdentityError(400, 'A valid email address is required', 'INVALID_EMAIL');
    if (this.authProfile === 'ONLINE') this.requireMail();
    if (!username.trim() || username.length < 3 || username.length > 50) throw new IdentityError(400, 'Invalid ADMIN username');
    if (!validPassword(password)) throw new IdentityError(400, 'Password must contain 12–128 Unicode characters');
    const hashed = await hashPassword(password);
    const verification = this.authProfile === 'ONLINE' ? generateToken() : undefined;
    const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS);
    const result = await this.db.withTransaction(async (client) => {
      await client.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
      const existing = await client.query("SELECT 1 FROM users WHERE role = 'ADMIN'");
      if (verification) {
        const configured = await client.query<{value:{limit?:unknown}}>("SELECT value FROM deployment_settings WHERE key='accountCapacity' FOR UPDATE");
        let limit = configured.rows[0]?.value?.limit;
        if (configured.rows.length === 0 && initialAccountCapacity !== undefined) {
          if (!Number.isSafeInteger(initialAccountCapacity) || initialAccountCapacity < 1) throw new IdentityError(400,'Initial accountCapacity must be a positive integer','ACCOUNT_CAPACITY_REQUIRED');
          await client.query("INSERT INTO deployment_settings(key,value) VALUES('accountCapacity',$1::jsonb)",[JSON.stringify({limit:initialAccountCapacity})]);
          limit = initialAccountCapacity;
        } else if (initialAccountCapacity !== undefined && initialAccountCapacity !== limit) {
          throw new IdentityError(409,'Configured accountCapacity does not match the operator confirmation','ACCOUNT_CAPACITY_CONFLICT');
        }
        if(typeof limit!=='number'||!Number.isSafeInteger(limit)||limit<1) throw new IdentityError(409,'A valid accountCapacity must be configured','ACCOUNT_CAPACITY_REQUIRED');
        const count=await client.query<{count:string}>('SELECT count(*)::text AS count FROM users');
        if(Number(count.rows[0].count)>=limit) throw new IdentityError(409,'Account capacity is full','ACCOUNT_CAPACITY_EXCEEDED');
      }
      if (existing.rows.length) throw new IdentityError(409, 'Singleton ADMIN account already bootstrapped');
      const inserted = await client.query<UserRow>(`INSERT INTO users(username,display_name,email,password_hash,role,activation_method,password_change_required,temporary_password_expires_at)
        VALUES($1,'Administrator',$2,$3,'ADMIN',$4,$5,CASE WHEN $5 THEN clock_timestamp()+interval '24 hours' ELSE NULL END) RETURNING *`,
        [username.trim(), normalizedEmail ?? null, hashed, verification ? 'SELF_REGISTER' : 'LOCAL_BOOTSTRAP', Boolean(verification)]);
      const user = inserted.rows[0];
      if (verification) {
        await client.query("INSERT INTO email_verification_tokens(user_id,token_hash,target_email,purpose,expires_at) VALUES($1,$2,$3,'EMAIL_VERIFICATION',$4)", [user.id, verification.hash, normalizedEmail, expiresAt]);
        await enqueueIdentityMail(client, this.requireMail().keyring, { userId: user.id, topic: 'EMAIL_VERIFICATION_REQUESTED', purpose: 'EMAIL_VERIFICATION', tokenHash: verification.hash, rawToken: verification.raw, recipient: normalizedEmail!, expiresAt });
      }
      await client.query("INSERT INTO audit_events(actor_user_id,action,resource_type,resource_id,details) VALUES($1::uuid,'ADMIN_BOOTSTRAPPED','user',$1::text,$2)", [user.id, JSON.stringify({ online: Boolean(verification) })]);
      return inserted;
    });
    return this.toUserDto(result.rows[0]);
  }
  async recoverOnlineAdmin(newEmail: string, reason: string, authorizationReference: string): Promise<{ readonly username: string; readonly id: UUID; readonly temporaryPassword: string }> {
    if (this.authProfile !== 'ONLINE') throw new IdentityError(404, 'Online admin recovery is unavailable in this profile', 'PROFILE_DISABLED');
    const mail = this.requireMail();
    const email = typeof newEmail === 'string' ? newEmail.trim().toLowerCase() : '';
    if (email.length > 254 || !EMAIL_PATTERN.test(email)) throw new IdentityError(400, 'A valid email address is required', 'INVALID_EMAIL');
    if (!reason.trim() || reason.length > 1000 || !authorizationReference.trim() || authorizationReference.length > 200) throw new IdentityError(400, 'Recovery reason and authorization reference are required', 'INVALID_RECOVERY_AUTHORITY');
    const temporary = generateTemporaryPassword();
    const hashed = await hashPassword(temporary);
    const verification = generateToken();
    const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS);
    return this.db.withTransaction(async (client) => {
      await client.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
      const found = await client.query<{ id: string; username: string; email: string | null }>("SELECT id,username,email FROM users WHERE role='ADMIN' FOR UPDATE");
      if (found.rows.length !== 1) throw new IdentityError(409, 'Recovery requires exactly one existing ADMIN', 'ADMIN_SINGLETON_REQUIRED');
      const admin = found.rows[0];
      const updated = await client.query("UPDATE users SET email=$2,email_verified_at=NULL,password_hash=$3,password_change_required=TRUE,activation_method='SELF_REGISTER',temporary_password_expires_at=clock_timestamp()+interval '24 hours',temporary_password_consumed_at=NULL,updated_at=clock_timestamp() WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM users WHERE email=$2 AND id<>$1) RETURNING id", [admin.id, email, hashed]);
      if (!updated.rows.length) throw new IdentityError(409, 'Email address is already registered', 'EMAIL_TAKEN');
      await client.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE user_id=$1 AND revoked_at IS NULL', [admin.id]);
      await client.query('UPDATE password_reset_tokens SET consumed_at=clock_timestamp() WHERE user_id=$1 AND consumed_at IS NULL', [admin.id]);
      await client.query('UPDATE email_verification_tokens SET consumed_at=clock_timestamp() WHERE user_id=$1 AND consumed_at IS NULL', [admin.id]);
      await client.query("UPDATE identity_mail_deliveries SET state='CANCELLED',envelope=NULL WHERE user_id=$1 AND state IN ('PENDING','SENDING','HELD')", [admin.id]);
      await client.query("INSERT INTO email_verification_tokens(user_id,token_hash,target_email,purpose,expires_at) VALUES($1,$2,$3,'EMAIL_VERIFICATION',$4)", [admin.id, verification.hash, email, expiresAt]);
      await enqueueIdentityMail(client, mail.keyring, { userId: admin.id, topic: 'EMAIL_VERIFICATION_REQUESTED', purpose: 'EMAIL_VERIFICATION', tokenHash: verification.hash, rawToken: verification.raw, recipient: email, expiresAt });
      await client.query(`INSERT INTO audit_events(actor_user_id,action,resource_type,resource_id,details) VALUES($1::uuid,'LOCAL_ADMIN_RECOVERY','user',$1::text,$2)`, [admin.id, JSON.stringify({ reason, authorizationReference })]);
      return { id: admin.id as UUID, username: admin.username, temporaryPassword: temporary };
    });
  }

  async lanBulkProvision(entries: readonly LanBulkUserEntry[], actor: Actor): Promise<readonly LanProvisionedUser[]> {
    if (actor.role !== 'ADMIN' || actor.scope !== 'FULL') {
      throw new IdentityError(403, 'Only fully authenticated ADMIN can provision LAN accounts');
    }
    // Issued credentials are a LAN_OFFLINE mechanism: they skip the mailbox gate by design, so an
    // ONLINE deployment must never mint one. Its siblings (reset, and the panel that calls them)
    // already refuse outside LAN_OFFLINE; provisioning has to agree with them.
    if (this.authProfile !== 'LAN_OFFLINE') {
      throw new IdentityError(404, 'LAN account provisioning is unavailable in this profile', 'PROFILE_DISABLED');
    }

    if (entries.length === 0) {
      return [];
    }


    return this.db.withTransaction(async (client) => {
      // Serialize every account writer, including ONLINE registration and direct SQL inserts.
      await client.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
      const capacity = await client.query<{ value: { limit?: unknown } }>(
        "SELECT value FROM deployment_settings WHERE key = 'accountCapacity' FOR UPDATE"
      );
      const limit = capacity.rows[0]?.value?.limit;
      if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1) {
        throw new IdentityError(409, 'A valid accountCapacity must be configured', 'ACCOUNT_CAPACITY_REQUIRED');
      }
      const count = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM users');
      if (Number(count.rows[0].count) + entries.length > limit) {
        throw new IdentityError(409, 'Account capacity would be exceeded', 'ACCOUNT_CAPACITY_EXCEEDED');
      }
      const provisioned: LanProvisionedUser[] = [];

      for (const entry of entries) {
        if (!entry || typeof entry.username !== 'string' || typeof entry.displayName !== 'string') {
          throw new IdentityError(400, 'Each account requires a username and displayName');
        }
        const username = entry.username.trim();
        const displayName = entry.displayName.trim() || username;
        if (!username || username.length < 2 || username.length > 50) {
          throw new IdentityError(400, `Invalid username: ${entry.username}`);
        }
        // The role model is ADMIN + STUDENT; an OPERATOR account would sign in to a portal with no
        // capability at all, so provisioning refuses to mint one.
        if (entry.role !== 'STUDENT') {
          throw new IdentityError(400, 'LAN bulk provisioning issues STUDENT accounts only', 'ROLE_NOT_PROVISIONABLE');
        }

        const tempPassword = generateTemporaryPassword();
        const hashed = await hashPassword(tempPassword);

        const inserted = await client.query<UserRow>(
          `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required, temporary_password_expires_at)
           VALUES ($1, $2, $3, $4, 'ADMIN_ISSUED', TRUE, clock_timestamp() + interval '24 hours')
           RETURNING *`,
          [username, displayName, hashed, entry.role]
        );

        const row = inserted.rows[0];
        await client.query(`INSERT INTO audit_events(actor_user_id, action, resource_type, resource_id, details)
          VALUES ($1, 'LAN_ACCOUNT_PROVISION', 'user', $2, $3)`,
          [actor.userId, row.id, JSON.stringify({ username, role: row.role })]);
        provisioned.push({
          userId: row.id,
          username: row.username,
          displayName: row.display_name,
          temporaryPassword: tempPassword,
        });
      }

      return provisioned;
    });
  }

  async login(username: string, password: string, ip = 'local-service'): Promise<SessionDto> {
    const trimmed = username.trim();
    const accountKey = hashToken(trimmed);
    const ipKey = hashToken(ip);
    const attemptId = await this.db.withTransaction(async (client) => {
      for (const key of [`account:${accountKey}`, `ip:${ipKey}`].sort()) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
      }
      await client.query("DELETE FROM identity_login_attempts WHERE attempted_at <= clock_timestamp() - INTERVAL '15 minutes'");
      const counts = await client.query<{ account_count: string; ip_count: string }>(
        `SELECT count(*) FILTER (WHERE account_key = $1)::text AS account_count,
                count(*) FILTER (WHERE ip_key = $2)::text AS ip_count FROM identity_login_attempts`, [accountKey, ipKey]);
      if (Number(counts.rows[0].account_count) >= 10 || Number(counts.rows[0].ip_count) >= 30) {
        throw new IdentityError(429, 'Too many login attempts; retry after 15 minutes', 'LOGIN_RATE_LIMITED');
      }
      const attempt = await client.query<{ id: string }>(
        'INSERT INTO identity_login_attempts(account_key, ip_key) VALUES ($1, $2) RETURNING id', [accountKey, ipKey]);
      return attempt.rows[0].id;
    });
    const result = await this.db.query<UserRow>('SELECT * FROM users WHERE username = $1', [trimmed]);
    const user = result.rows[0];

    const passwordOk = await verifyPassword(password, user?.password_hash ?? 'invalid');
    if (!user || !passwordOk) {
      throw new IdentityError(401, 'Invalid username or password');
    }

    await this.db.query('DELETE FROM identity_login_attempts WHERE id = $1', [attemptId]);
    if (needsPasswordRehash(user.password_hash)) {
      const upgraded = await hashPassword(password);
      const changed = await this.db.query(
        'UPDATE users SET password_hash = $1 WHERE id = $2 AND password_hash = $3 RETURNING id',
        [upgraded, user.id, user.password_hash]);
      if (!changed.rows.length) throw new IdentityError(401, 'Credentials changed; sign in again');
      user.password_hash = upgraded;
    }
    if (this.authProfile === 'ONLINE') {
      const verified = await this.db.query('SELECT 1 FROM users WHERE id=$1 AND email IS NOT NULL AND email_verified_at IS NOT NULL', [user.id]);
      if (!verified.rows.length) throw new IdentityError(403, 'Email address is not verified for this account', 'EMAIL_VERIFICATION_REQUIRED');
    }

    const scope: SessionScope = user.password_change_required ? 'PASSWORD_CHANGE_ONLY' : 'FULL';
    const { raw, hash } = generateToken();
    const expiresAt = new Date(Date.now() + (user.role === 'ADMIN' ? 12 * 60 * 60 * 1000 : SESSION_TTL_MS));

    const sessionResult = await this.db.withTransaction(async (client) => {
      const current = await client.query<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [user.id]);
      if (!current.rows[0] || current.rows[0].password_hash !== user.password_hash) {
        throw new IdentityError(401, 'Credentials changed; sign in again');
      }
      if (current.rows[0].password_change_required && current.rows[0].activation_method === 'ADMIN_ISSUED') {
        const consumed = await client.query(`UPDATE users SET temporary_password_consumed_at = clock_timestamp()
          WHERE id = $1 AND temporary_password_consumed_at IS NULL
            AND temporary_password_expires_at > clock_timestamp() RETURNING id`, [user.id]);
        if (!consumed.rows.length) throw new IdentityError(401, 'Temporary credential expired or already used', 'TEMPORARY_CREDENTIAL_INVALID');
        expiresAt.setTime(Math.min(expiresAt.getTime(), current.rows[0].temporary_password_expires_at!.getTime()));
      }
      return client.query<SessionRow>(
        `INSERT INTO sessions (user_id, token_hash, scope, expires_at)
         VALUES ($1, $2, $3, $4) RETURNING *`, [user.id, hash, scope, expiresAt]);
    });

    const session = sessionResult.rows[0];
    return {
      sessionId: session.id,
      token: raw,
      scope,
      expiresAt: session.expires_at.toISOString(),
      user: this.toUserDto(user),
    };
  }

  /**
   * ONLINE self-registration. Creates an unverified STUDENT account plus a
   * purpose-bound mailbox-confirmation token (24 h). The plaintext token reaches
   * the outbox payload only under the development transport flag; production
   * would mail it instead.
   */
  async register(input: RegistrationInput): Promise<RegistrationResult> {
    const username = typeof input.username === 'string' ? input.username.trim() : '';
    if (username.length < 3 || username.length > 50) {
      throw new IdentityError(400, 'Username must be between 3 and 50 characters', 'INVALID_USERNAME');
    }
    const displayName = (typeof input.displayName === 'string' ? input.displayName.trim() : '') || username;
    if (displayName.length > 100) {
      throw new IdentityError(400, 'Display name must be at most 100 characters', 'INVALID_DISPLAY_NAME');
    }
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
      throw new IdentityError(400, 'A valid email address is required', 'INVALID_EMAIL');
    }
    if (!validPassword(input.password)) {
      throw new IdentityError(400, 'Password must contain 12–128 Unicode characters', 'WEAK_PASSWORD');
    }

    const passwordHash = await hashPassword(input.password);
    const verification = generateToken();
    const verificationExpiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS);
    const mail = this.requireMail();
    return this.db.withTransaction(async (client) => {
      await client.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
      const capacity = await client.query<{ value: { limit?: unknown } }>("SELECT value FROM deployment_settings WHERE key='accountCapacity' FOR UPDATE");
      const limit = capacity.rows[0]?.value?.limit;
      if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1) throw new IdentityError(409, 'A valid accountCapacity must be configured', 'ACCOUNT_CAPACITY_REQUIRED');
      const count = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM users');
      if (Number(count.rows[0].count) >= limit) throw new IdentityError(409, 'Account capacity is full', 'ACCOUNT_CAPACITY_EXCEEDED');
      const clash = await client.query<{ username: string; email: string | null }>('SELECT username,email FROM users WHERE username=$1 OR email=$2', [username,email]);
      if (clash.rows.some((row) => row.username === username)) throw new IdentityError(409, 'Username is already taken', 'USERNAME_TAKEN');
      if (clash.rows.some((row) => row.email === email)) throw new IdentityError(409, 'Email address is already registered', 'EMAIL_TAKEN');
      const inserted = await client.query<UserRow>(`INSERT INTO users(username,display_name,email,password_hash,role,activation_method,password_change_required)
        VALUES($1,$2,$3,$4,'STUDENT','SELF_REGISTER',FALSE) RETURNING *`, [username,displayName,email,passwordHash]);
      const user = inserted.rows[0];
      await client.query("INSERT INTO email_verification_tokens(user_id,token_hash,target_email,purpose,expires_at) VALUES($1,$2,$3,'EMAIL_VERIFICATION',$4)", [user.id,verification.hash,email,verificationExpiresAt]);
      await enqueueIdentityMail(client, mail.keyring, { userId:user.id, topic:'EMAIL_VERIFICATION_REQUESTED', purpose:'EMAIL_VERIFICATION', tokenHash:verification.hash, rawToken:verification.raw, recipient:email, expiresAt:verificationExpiresAt });
      return { user:this.toUserDto(user), emailVerificationRequired:true as const };
    });
  }

  /** Consumes a mailbox-confirmation token; the failure code is machine-readable. */
  async verifyEmail(token: string): Promise<{ verified: true }> {
    if (typeof token !== 'string' || token.length === 0) throw new IdentityError(400, 'Verification token is required', 'EMAIL_VERIFICATION_INVALID');
    const hash = hashToken(token);
    return this.db.withTransaction(async (client) => {
      const candidate = await client.query<{id:string;user_id:string;target_email:string;purpose:string;consumed_at:Date|null}>('SELECT id,user_id,target_email,purpose,consumed_at FROM email_verification_tokens WHERE token_hash=$1', [hash]);
      const row = candidate.rows[0];
      if (!row) throw new IdentityError(400, 'Verification token is invalid', 'EMAIL_VERIFICATION_INVALID');
      const user = await client.query<{ email:string|null }>('SELECT email FROM users WHERE id=$1 FOR UPDATE', [row.user_id]);
      if (!user.rows.length) throw new IdentityError(400, 'Verification token is invalid', 'EMAIL_VERIFICATION_INVALID');
      const locked = await client.query('SELECT consumed_at FROM email_verification_tokens WHERE id=$1 FOR UPDATE', [row.id]);
      if (locked.rows[0]?.consumed_at) throw new IdentityError(400, 'Verification token has already been used', 'EMAIL_VERIFICATION_CONSUMED');
      const live = await client.query('SELECT 1 FROM email_verification_tokens WHERE id=$1 AND expires_at>clock_timestamp()', [row.id]);
      if (!live.rows.length) throw new IdentityError(400, 'Verification token has expired', 'EMAIL_VERIFICATION_EXPIRED');
      if (row.purpose === 'EMAIL_VERIFICATION') {
        if (user.rows[0].email !== row.target_email) throw new IdentityError(400, 'Verification token no longer matches this address', 'EMAIL_VERIFICATION_INVALID');
        await client.query('UPDATE users SET email_verified_at=clock_timestamp() WHERE id=$1 AND email=$2', [row.user_id,row.target_email]);
      } else if (row.purpose === 'EMAIL_CHANGE') {
        const prior = user.rows[0].email;
        const updated = await client.query('UPDATE users SET email=$2,email_verified_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM users WHERE email=$2 AND id<>$1) RETURNING id', [row.user_id,row.target_email]);
        if (!updated.rows.length) throw new IdentityError(409, 'Email address is already registered', 'EMAIL_TAKEN');
        await client.query('UPDATE email_verification_tokens SET consumed_at=clock_timestamp() WHERE user_id=$1 AND id<>$2 AND consumed_at IS NULL', [row.user_id,row.id]);
        await client.query('UPDATE password_reset_tokens SET consumed_at=clock_timestamp() WHERE user_id=$1 AND consumed_at IS NULL', [row.user_id]);
        await client.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE user_id=$1 AND revoked_at IS NULL', [row.user_id]);
        if (prior) { const mail=this.requireMail(); const expiresAt=new Date(Date.now()+24*60*60*1000); await enqueueIdentityMail(client,mail.keyring,{userId:row.user_id,topic:'EMAIL_CHANGED',purpose:'EMAIL_CHANGED',recipient:prior,expiresAt}); }
      } else throw new IdentityError(400, 'Wrong verification token purpose', 'EMAIL_VERIFICATION_INVALID');
      await client.query('UPDATE email_verification_tokens SET consumed_at=clock_timestamp() WHERE id=$1', [row.id]);
      return { verified:true as const };
    });
  }
  private async checkIdentityRate(client: PoolClient, account: string, ip: string): Promise<void> {
    const limits: readonly [string, number][] = [[`account:${hashToken(account)}`, RATE_LIMIT_ACCOUNT], [`ip:${hashToken(ip)}`, RATE_LIMIT_IP]];
    for (const [key, maximum] of limits) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
      const current = await client.query<{ window_start: Date; attempts: number; age_seconds: number }>(
        `SELECT window_start, attempts, floor(extract(epoch FROM clock_timestamp()-window_start))::int AS age_seconds
         FROM identity_rate_limits WHERE key=$1 ORDER BY window_start DESC LIMIT 1 FOR UPDATE`, [key]);
      let attempts = current.rows[0]?.attempts ?? 0;
      const ageSeconds = current.rows[0]?.age_seconds;
      if (ageSeconds === undefined || ageSeconds >= 3600) attempts = 0;
      attempts += 1;
      await client.query('DELETE FROM identity_rate_limits WHERE key=$1', [key]);
      await client.query('INSERT INTO identity_rate_limits(key,window_start,attempts) VALUES($1,clock_timestamp(),$2)', [key, attempts]);
      if (attempts > maximum) throw new IdentityError(429, 'Too many identity requests; retry later', 'IDENTITY_RATE_LIMITED', Math.max(1, 3600 - (ageSeconds ?? 0)));
    }
  }

  async resendVerification(email: string, ip: string): Promise<void> {
    const normalized=email.trim().toLowerCase(); if (normalized.length>254 || !EMAIL_PATTERN.test(normalized)) return;
    const mail=this.requireMail(); const token=generateToken(); const expiresAt=new Date(Date.now()+EMAIL_VERIFICATION_TTL_MS);
    await this.db.withTransaction(async client=>{
      await this.checkIdentityRate(client,normalized,ip);
      const found=await client.query<{id:string;email:string|null;email_verified_at:Date|null}>('SELECT id,email,email_verified_at FROM users WHERE email=$1 FOR UPDATE',[normalized]);
      const user=found.rows[0]; if (!user || user.email_verified_at) return;
      await client.query("UPDATE email_verification_tokens SET consumed_at=clock_timestamp() WHERE user_id=$1 AND purpose='EMAIL_VERIFICATION' AND consumed_at IS NULL",[user.id]);
      await client.query("UPDATE identity_mail_deliveries SET state='CANCELLED',envelope=NULL WHERE user_id=$1 AND purpose='EMAIL_VERIFICATION' AND state='PENDING'",[user.id]);
      await client.query("INSERT INTO email_verification_tokens(user_id,token_hash,target_email,purpose,expires_at) VALUES($1,$2,$3,'EMAIL_VERIFICATION',$4)",[user.id,token.hash,normalized,expiresAt]);
      await enqueueIdentityMail(client,mail.keyring,{userId:user.id,topic:'EMAIL_VERIFICATION_REQUESTED',purpose:'EMAIL_VERIFICATION',tokenHash:token.hash,rawToken:token.raw,recipient:normalized,expiresAt});
    });
  }
  async requestEmailChange(sessionToken: string, newEmail: string): Promise<void> {
    const email=typeof newEmail==='string'?newEmail.trim().toLowerCase():'';
    if(email.length>254||!EMAIL_PATTERN.test(email)) throw new IdentityError(400,'A valid email address is required','INVALID_EMAIL');
    const mail=this.requireMail(); const verification=generateToken(); const expiresAt=new Date(Date.now()+EMAIL_VERIFICATION_TTL_MS);
    await this.db.withTransaction(async client=>{
      const session=await client.query<{user_id:string;scope:string;reauthenticated_at:Date|null}>('SELECT user_id,scope,reauthenticated_at FROM sessions WHERE token_hash=$1 AND identity_session_valid(sessions) FOR UPDATE',[hashToken(sessionToken)]);
      const auth=session.rows[0]; if(!auth) throw new IdentityError(401,'Session expired or revoked','UNAUTHENTICATED');
      if(auth.scope!=='FULL') throw new IdentityError(403,'Full session required','PASSWORD_CHANGE_REQUIRED');
      if(!auth.reauthenticated_at || auth.reauthenticated_at<=new Date(Date.now()-10*60*1000)) throw new IdentityError(403,'Recent re-authentication required','REAUTH_REQUIRED');
      const user=await client.query<{email:string|null}>('SELECT email FROM users WHERE id=$1 FOR UPDATE',[auth.user_id]);
      if(!user.rows[0]?.email) throw new IdentityError(409,'Account has no current email','EMAIL_REQUIRED');
      const existing=await client.query('SELECT 1 FROM users WHERE email=$1 AND id<>$2',[email,auth.user_id]);
      if(existing.rows.length) throw new IdentityError(409,'Email address is already registered','EMAIL_TAKEN');
      await client.query("UPDATE email_verification_tokens SET consumed_at=clock_timestamp() WHERE user_id=$1 AND purpose='EMAIL_CHANGE' AND consumed_at IS NULL",[auth.user_id]);
      await client.query("UPDATE identity_mail_deliveries SET state='CANCELLED',envelope=NULL WHERE user_id=$1 AND purpose='EMAIL_CHANGE' AND state='PENDING'",[auth.user_id]);
      await client.query("INSERT INTO email_verification_tokens(user_id,token_hash,target_email,purpose,expires_at) VALUES($1,$2,$3,'EMAIL_CHANGE',$4)",[auth.user_id,verification.hash,email,expiresAt]);
      await enqueueIdentityMail(client,mail.keyring,{userId:auth.user_id,topic:'EMAIL_CHANGE_REQUESTED',purpose:'EMAIL_CHANGE',tokenHash:verification.hash,rawToken:verification.raw,recipient:email,expiresAt});
    });
  }

  /**
   * Starts e-mail recovery without disclosing whether the address is registered:
   * the caller answers 202 either way and a token exists only for known users.
   */
  async requestPasswordReset(email: string, ip = 'local-service'): Promise<void> {
    const normalized=typeof email==='string'?email.trim().toLowerCase():'';
    if(normalized.length>254||!EMAIL_PATTERN.test(normalized)) return;
    const mail=this.requireMail(); const reset=generateToken(); const expiresAt=new Date(Date.now()+PASSWORD_RESET_TTL_MS);
    await this.db.withTransaction(async client=>{
      await this.checkIdentityRate(client,normalized,ip);
      const found=await client.query<{id:string;email:string}>('SELECT id,email FROM users WHERE email=$1 FOR UPDATE',[normalized]);
      const user=found.rows[0]; if(!user) return;
      await client.query('INSERT INTO password_reset_tokens(user_id,token_hash,target_email,expires_at) VALUES($1,$2,$3,$4)',[user.id,reset.hash,user.email,expiresAt]);
      await enqueueIdentityMail(client,mail.keyring,{userId:user.id,topic:'PASSWORD_RESET_REQUESTED',purpose:'PASSWORD_RESET',tokenHash:reset.hash,rawToken:reset.raw,recipient:user.email,expiresAt});
    });
  }

  /**
   * Redeems a one-use recovery token: rotates the password hash, clears the
   * forced-change flag and revokes every session the account still holds.
   */
  async resetPassword(token: string, newPassword: string): Promise<{ reset: true }> {
    if (!validPassword(newPassword)) throw new IdentityError(400, 'Password must contain 12–128 Unicode characters', 'WEAK_PASSWORD');
    if (typeof token !== 'string' || token.length === 0) throw new IdentityError(400, 'Reset token is required', 'PASSWORD_RESET_INVALID');
    const hash=hashToken(token); const newHash=await hashPassword(newPassword);
    return this.db.withTransaction(async client=>{
      const candidate=await client.query<{id:string;user_id:string;target_email:string|null;consumed_at:Date|null}>('SELECT id,user_id,target_email,consumed_at FROM password_reset_tokens WHERE token_hash=$1',[hash]);
      const row=candidate.rows[0]; if(!row) throw new IdentityError(400,'Reset token is invalid','PASSWORD_RESET_INVALID');
      const user=await client.query<{email:string|null}>('SELECT email FROM users WHERE id=$1 FOR UPDATE',[row.user_id]);
      if(!user.rows.length||user.rows[0].email!==row.target_email) throw new IdentityError(400,'Reset token no longer matches this address','PASSWORD_RESET_INVALID');
      const locked=await client.query('SELECT consumed_at FROM password_reset_tokens WHERE id=$1 FOR UPDATE',[row.id]);
      if(locked.rows[0]?.consumed_at) throw new IdentityError(400,'Reset token has already been used','PASSWORD_RESET_CONSUMED');
      const valid=await client.query('SELECT 1 FROM password_reset_tokens WHERE id=$1 AND expires_at>clock_timestamp()',[row.id]);
      if(!valid.rows.length) throw new IdentityError(400,'Reset token has expired','PASSWORD_RESET_EXPIRED');
      await client.query('UPDATE password_reset_tokens SET consumed_at=clock_timestamp() WHERE user_id=$1 AND consumed_at IS NULL',[row.user_id]);
      await client.query("UPDATE identity_mail_deliveries SET state='CANCELLED',envelope=NULL WHERE user_id=$1 AND purpose='PASSWORD_RESET' AND state='PENDING'",[row.user_id]);
      await client.query('UPDATE users SET password_hash=$1,password_change_required=FALSE,updated_at=clock_timestamp() WHERE id=$2',[newHash,row.user_id]);
      await client.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE user_id=$1 AND revoked_at IS NULL',[row.user_id]);
      return {reset:true as const};
    });
  }

  private requireAdmin(actor: Actor): void {
    if (actor.role !== 'ADMIN' || actor.scope !== 'FULL') throw new IdentityError(403, 'Fully authenticated ADMIN required', 'FORBIDDEN');
  }

  async listAccounts(actor: Actor): Promise<readonly UserDto[]> {
    this.requireAdmin(actor);
    const result = await this.db.query<UserRow>('SELECT * FROM users ORDER BY username');
    return result.rows.map((row) => this.toUserDto(row));
  }

  async resetLanStudentPassword(userId: UUID, actor: Actor): Promise<LanProvisionedUser> {
    this.requireAdmin(actor);
    if (this.authProfile !== 'LAN_OFFLINE') throw new IdentityError(404, 'LAN reset is unavailable', 'PROFILE_DISABLED');
    const temporaryPassword = generateTemporaryPassword();
    const hashed = await hashPassword(temporaryPassword);
    return this.db.withTransaction(async (client) => {
      const result = await client.query<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
      const user = result.rows[0];
      if (!user) throw new IdentityError(404, 'User not found');
      if (user.role !== 'STUDENT' || user.activation_method !== 'ADMIN_ISSUED') throw new IdentityError(403, 'Only LAN-issued students may be reset', 'FORBIDDEN');
      await client.query(`UPDATE users SET password_hash = $2, password_change_required = TRUE,
        temporary_password_expires_at = clock_timestamp() + interval '24 hours', temporary_password_consumed_at = NULL,
        updated_at = clock_timestamp() WHERE id = $1`, [userId, hashed]);
      await client.query('UPDATE sessions SET revoked_at = clock_timestamp() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
      await client.query(`INSERT INTO audit_events(actor_user_id, action, resource_type, resource_id, details)
        VALUES ($1, 'LAN_PASSWORD_RESET', 'user', $2, '{}')`, [actor.userId, userId]);
      return { userId, username: user.username, displayName: user.display_name, temporaryPassword };
    });
  }

  async revokeUserSessions(userId: UUID, actor: Actor): Promise<{ revoked: number }> {
    this.requireAdmin(actor);
    return this.db.withTransaction(async (client) => {
      const user = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
      if (!user.rows.length) throw new IdentityError(404, 'User not found');
      const result = await client.query('UPDATE sessions SET revoked_at = clock_timestamp() WHERE user_id = $1 AND revoked_at IS NULL RETURNING id', [userId]);
      await client.query(`INSERT INTO audit_events(actor_user_id, action, resource_type, resource_id, details)
        VALUES ($1, 'ADMIN_REVOKE_SESSIONS', 'user', $2, $3)`, [actor.userId, userId, JSON.stringify({ revoked: result.rows.length })]);
      return { revoked: result.rows.length };
    });
  }

  async listAuditEvents(actor: Actor, resourceId?: string): Promise<readonly { id: string; action: string; resourceType: string; resourceId: string | null; actorUserId: string | null; details: unknown; createdAt: string }[]> {
    this.requireAdmin(actor);
    const result = await this.db.query<{ id: string; action: string; resource_type: string; resource_id: string | null; actor_user_id: string | null; details: unknown; created_at: Date }>(
      `SELECT * FROM audit_events WHERE ($1::text IS NULL OR resource_id::text = $1) ORDER BY created_at DESC, id DESC LIMIT 200`, [resourceId ?? null]);
    return result.rows.map((row) => ({ id: row.id, action: row.action, resourceType: row.resource_type, resourceId: row.resource_id, actorUserId: row.actor_user_id, details: row.details, createdAt: row.created_at.toISOString() }));
  }

  private toUserDto(row: UserRow): UserDto {
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      email: row.email ?? undefined,
      passwordChangeRequired: row.password_change_required,
      createdAt: row.created_at.toISOString(),
    };
  }

  async changePassword(userId: UUID, oldPassword: string, newPassword: string): Promise<SessionDto> {
    if (!validPassword(newPassword)) {
      throw new IdentityError(400, 'Password must contain 12–128 Unicode characters');
    }

    return this.db.withTransaction(async (client) => {
      const userResult = await client.query<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
      const user = userResult.rows[0];
      if (!user) {
        throw new IdentityError(404, 'User not found');
      }

      const match = await verifyPassword(oldPassword, user.password_hash);
      if (!match) {
        throw new IdentityError(401, 'Incorrect old password');
      }
      if (user.password_change_required && user.activation_method === 'ADMIN_ISSUED') {
        const valid = await client.query('SELECT 1 FROM users WHERE id = $1 AND temporary_password_expires_at > clock_timestamp()', [userId]);
        if (!valid.rows.length) throw new IdentityError(401, 'Temporary credential expired', 'TEMPORARY_CREDENTIAL_INVALID');
      }
      if (oldPassword === newPassword) throw new IdentityError(400, 'Choose a different permanent password');

      const newHash = await hashPassword(newPassword);
      await client.query(
        'UPDATE users SET password_hash = $1, password_change_required = FALSE, temporary_password_expires_at = NULL, temporary_password_consumed_at = NULL, updated_at = clock_timestamp() WHERE id = $2',
        [newHash, userId]
      );

      // Revoke all existing sessions (including the temporary change-password session)
      await client.query('UPDATE sessions SET revoked_at = clock_timestamp() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);

      // Issue fresh FULL session
      const { raw, hash } = generateToken();
      const expiresAt = new Date(Date.now() + (user.role === 'ADMIN' ? 12 * 60 * 60 * 1000 : SESSION_TTL_MS));
      const sessionResult = await client.query<SessionRow>(
        `INSERT INTO sessions (user_id, token_hash, scope, expires_at)
         VALUES ($1, $2, 'FULL', $3)
         RETURNING *`,
        [userId, hash, expiresAt]
      );

      const session = sessionResult.rows[0];
      return {
        sessionId: session.id,
        token: raw,
        scope: 'FULL',
        expiresAt: session.expires_at.toISOString(),
        user: {
          id: user.id,
          username: user.username,
          displayName: user.display_name,
          role: user.role,
          email: user.email ?? undefined,
          passwordChangeRequired: false,
          createdAt: user.created_at.toISOString(),
        },
      };
    });
  }

  /**
   * Re-confirms the signed-in user's own password for the current session. Only
   * `POST /api/v2/auth/reauth` calls this; the stamp lives on the session row (`reauthenticated_at`),
   * so confirming one session never unlocks another session of the same account, and it is audited as
   * `ADMIN_REAUTH` together with the stamped instant.
   */
  async reauthenticate(token: string, password: string): Promise<ReauthReceipt> {
    const sessionRes = await this.db.query<{
      id: string;
      user_id: string;
      scope: SessionScope;
      password_hash: string;
    }>(
      `SELECT s.id, s.user_id, s.scope, u.password_hash
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND identity_session_valid(s)
       LIMIT 1`,
      [hashToken(token)]
    );
    const session = sessionRes.rows[0];
    if (!session) {
      throw new IdentityError(401, 'Session expired or revoked', 'UNAUTHENTICATED');
    }
    // A limited session exists only to change the password; it is not an operator session.
    if (session.scope !== 'FULL') {
      throw new IdentityError(403, 'Password change is required before this action', 'PASSWORD_CHANGE_REQUIRED');
    }

    const passwordOk = await verifyPassword(password, session.password_hash);
    if (!passwordOk) {
      throw new IdentityError(401, 'Incorrect password', 'INVALID_CREDENTIALS');
    }

    return this.db.withTransaction(async (client) => {
      const stamped = await client.query<{ reauthenticated_until: Date }>(
        `UPDATE sessions
         SET reauthenticated_at = clock_timestamp()
         WHERE id = $1 AND identity_session_valid(sessions)
         RETURNING reauthenticated_at + ${REAUTH_WINDOW_SQL} AS reauthenticated_until`,
        [session.id]
      );
      const row = stamped.rows[0];
      if (!row) {
        throw new IdentityError(401, 'Session expired or revoked', 'UNAUTHENTICATED');
      }
      const reauthenticatedUntil = row.reauthenticated_until.toISOString();
      await client.query(
        `INSERT INTO audit_events (actor_user_id, action, resource_type, resource_id, details)
         VALUES ($1, 'ADMIN_REAUTH', 'session', $2, $3)`,
        [session.user_id, session.id, JSON.stringify({ reauthenticatedUntil })]
      );
      return { reauthenticatedUntil };
    });
  }

  /**
   * Gate for the destructive organizer routes (migration 016). Reads the session row by token hash
   * and compares `reauthenticated_at` against the *database* clock, so neither a request field nor a
   * skewed client clock can widen the window. Throws 403 `REAUTH_REQUIRED` when the session never
   * confirmed a password or its confirmation is older than 10 minutes.
   */
  async assertRecentReauth(token: string): Promise<void> {
    const res = await this.db.query<{ recent: boolean }>(
      `SELECT (reauthenticated_at IS NOT NULL AND reauthenticated_at > clock_timestamp() - ${REAUTH_WINDOW_SQL}) AS recent
       FROM sessions
       WHERE token_hash = $1 AND scope = 'FULL' AND identity_session_valid(sessions)
       LIMIT 1`,
      [hashToken(token)]
    );
    const session = res.rows[0];
    if (!session) {
      throw new IdentityError(401, 'Session expired or revoked', 'UNAUTHENTICATED');
    }
    if (!session.recent) {
      throw new IdentityError(403, 'Recent re-authentication required for this action', 'REAUTH_REQUIRED');
    }
  }

  async authenticateToken(token: string): Promise<{ actor: Actor; user: UserDto } | undefined> {
    if (!token || typeof token !== 'string') {
      return undefined;
    }
    const hash = hashToken(token);

    const query = `
      SELECT s.id AS session_id, s.scope, s.expires_at, s.revoked_at,
             u.id AS user_id, u.username, u.display_name, u.email, u.role, u.password_change_required, u.created_at AS user_created_at
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND identity_session_valid(s)
        AND ($2::boolean = FALSE OR (u.email IS NOT NULL AND u.email_verified_at IS NOT NULL))
      LIMIT 1
    `;
    const res = await this.db.query<{
      session_id: string;
      scope: SessionScope;
      expires_at: Date;
      revoked_at: Date | null;
      user_id: string;
      username: string;
      display_name: string;
      email: string | null;
      role: Role;
      password_change_required: boolean;
      user_created_at: Date;
    }>(query, [hash, this.authProfile === 'ONLINE']);

    const row = res.rows[0];
    if (!row) {
      return undefined;
    }
    // Idle tracking slides on activity, but a burst of requests must not write a WAL record each
    // time: the stamp is refreshed at most once per activity interval. A skipped refresh still
    // has to prove the session is valid, which keeps the revoke race closed while turning the
    // common repeat request into a read.
    const touched = await this.db.query(
      `UPDATE sessions SET last_seen_at = clock_timestamp()
       WHERE id = $1 AND identity_session_valid(sessions)
         AND last_seen_at < clock_timestamp() - interval '30 seconds'
       RETURNING id`,
      [row.session_id]
    );
    if (!touched.rows.length) {
      const stillValid = await this.db.query(
        'SELECT 1 FROM sessions s WHERE s.id = $1 AND identity_session_valid(s)',
        [row.session_id]
      );
      if (!stillValid.rows.length) return undefined;
    }

    // Lookup user's team memberships
    const teamRes = row.scope === 'FULL' ? await this.db.query<{ team_id: string }>(
      'SELECT team_id FROM team_memberships WHERE user_id = $1',
      [row.user_id]
    ) : { rows: [] };
    const teamIds = teamRes.rows.map((r) => r.team_id);

    const actor: Actor = {
      userId: row.user_id,
      role: row.role,
      username: row.username,
      teamIds,
      scope: row.scope,
    };

    const user: UserDto = {
      id: row.user_id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      email: row.email ?? undefined,
      passwordChangeRequired: row.password_change_required,
      createdAt: row.user_created_at.toISOString(),
    };

    return { actor, user };
  }

  async revokeSession(token: string): Promise<boolean> {
    const hash = hashToken(token);
    const res = await this.db.query(
      'UPDATE sessions SET revoked_at = clock_timestamp() WHERE token_hash = $1 AND revoked_at IS NULL',
      [hash]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async revokeAllUserSessions(userId: UUID): Promise<number> {
    const res = await this.db.query(
      'UPDATE sessions SET revoked_at = clock_timestamp() WHERE user_id = $1 AND revoked_at IS NULL',
      [userId]
    );
    return res.rowCount ?? 0;
  }
}
