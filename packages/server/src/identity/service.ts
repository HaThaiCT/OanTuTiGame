import type { Database } from '../persistence/db.js';
import { hashPassword, verifyPassword, generateToken, generateTemporaryPassword, hashToken } from './crypto.js';
import type { Actor, Instant, Role, SessionScope, UUID } from '@oantuti/protocol';
import type { LanBulkUserEntry, LanProvisionedUser, SessionDto, UserDto } from '@oantuti/protocol';

export class IdentityError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    /** Optional machine-readable discriminator surfaced by the HTTP layer. */
    readonly code?: string
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
  readonly password_hash: string;
  readonly role: Role;
  readonly activation_method: string;
  readonly password_change_required: boolean;
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
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1 hour
/** Self-service credentials are stricter than the admin-issued bootstrap minimum. */
const MIN_PASSWORD_LENGTH = 12;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

  constructor(private readonly db: Database, authProfile?: AuthProfile) {
    this.authProfile =
      authProfile ?? (process.env.OANTUTI_AUTH_PROFILE?.trim().toUpperCase() === 'ONLINE' ? 'ONLINE' : 'LAN_OFFLINE');
  }

  async bootstrapAdmin(username: string, password: string): Promise<UserDto> {
    const existing = await this.db.query<UserRow>('SELECT * FROM users WHERE role = $1 LIMIT 1', ['ADMIN']);
    if (existing.rows.length > 0) {
      throw new IdentityError(409, 'Singleton ADMIN account already bootstrapped');
    }

    if (!username.trim() || username.length < 3 || username.length > 50) {
      throw new IdentityError(400, 'Invalid ADMIN username');
    }
    if (!password || password.length < 8) {
      throw new IdentityError(400, 'ADMIN password must be at least 8 characters');
    }

    const hashed = await hashPassword(password);
    const result = await this.db.query<UserRow>(
      `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
       VALUES ($1, $2, $3, 'ADMIN', 'LOCAL_BOOTSTRAP', FALSE)
       RETURNING *`,
      [username.trim(), 'Administrator', hashed]
    );

    const user = result.rows[0];
    return {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role,
      passwordChangeRequired: user.password_change_required,
      createdAt: user.created_at.toISOString(),
    };
  }

  async lanBulkProvision(entries: readonly LanBulkUserEntry[], actor: Actor): Promise<readonly LanProvisionedUser[]> {
    if (actor.role !== 'ADMIN' || actor.scope !== 'FULL') {
      throw new IdentityError(403, 'Only fully authenticated ADMIN can provision LAN accounts');
    }

    if (entries.length === 0) {
      return [];
    }

    // Check accountCapacity setting if configured
    const capacitySetting = await this.db.query<{ value: { limit?: number } }>(
      "SELECT value FROM deployment_settings WHERE key = 'accountCapacity'"
    );
    const capacityLimit = capacitySetting.rows[0]?.value?.limit;
    if (typeof capacityLimit === 'number' && capacityLimit > 0) {
      const currentUsers = await this.db.query<{ count: string }>('SELECT count(*)::text AS count FROM users');
      const totalAfter = parseInt(currentUsers.rows[0].count, 10) + entries.length;
      if (totalAfter > capacityLimit) {
        throw new IdentityError(409, `Account capacity of ${capacityLimit} would be exceeded (current: ${currentUsers.rows[0].count}, requested: ${entries.length})`);
      }
    }

    return this.db.withTransaction(async (client) => {
      const provisioned: LanProvisionedUser[] = [];

      for (const entry of entries) {
        const username = entry.username.trim();
        const displayName = entry.displayName.trim() || username;
        if (!username || username.length < 2 || username.length > 50) {
          throw new IdentityError(400, `Invalid username: ${entry.username}`);
        }
        if (!['STUDENT', 'OPERATOR'].includes(entry.role)) {
          throw new IdentityError(400, 'LAN bulk provisioning only allows STUDENT or OPERATOR roles');
        }

        const tempPassword = generateTemporaryPassword();
        const hashed = await hashPassword(tempPassword);

        const inserted = await client.query<UserRow>(
          `INSERT INTO users (username, display_name, password_hash, role, activation_method, password_change_required)
           VALUES ($1, $2, $3, $4, 'ADMIN_ISSUED', TRUE)
           RETURNING *`,
          [username, displayName, hashed, entry.role]
        );

        const row = inserted.rows[0];
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

  async login(username: string, password: string): Promise<SessionDto> {
    const trimmed = username.trim();
    const result = await this.db.query<UserRow>('SELECT * FROM users WHERE username = $1', [trimmed]);
    const user = result.rows[0];

    const passwordOk = user ? await verifyPassword(password, user.password_hash) : false;
    if (!user || !passwordOk) {
      throw new IdentityError(401, 'Invalid username or password');
    }

    // ONLINE gates self-registered accounts on the mailbox confirmation; LAN_OFFLINE
    // has no mail transport and therefore ignores verification entirely. Admin-issued
    // and locally bootstrapped accounts never carry the self-registration gate.
    if (this.authProfile === 'ONLINE' && user.activation_method === 'SELF_REGISTER') {
      const verified = await this.db.query(
        `SELECT 1 FROM email_verification_tokens
         WHERE user_id = $1 AND purpose = 'EMAIL_VERIFICATION' AND consumed_at IS NOT NULL
         LIMIT 1`,
        [user.id]
      );
      if (verified.rows.length === 0) {
        throw new IdentityError(403, 'Email address is not verified for this account', 'EMAIL_NOT_VERIFIED');
      }
    }

    const scope: SessionScope = user.password_change_required ? 'PASSWORD_CHANGE_ONLY' : 'FULL';
    const { raw, hash } = generateToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    const sessionResult = await this.db.query<SessionRow>(
      `INSERT INTO sessions (user_id, token_hash, scope, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [user.id, hash, scope, expiresAt]
    );

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
    if (typeof input.password !== 'string' || input.password.length < MIN_PASSWORD_LENGTH) {
      throw new IdentityError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`, 'WEAK_PASSWORD');
    }

    const passwordHash = await hashPassword(input.password);
    const verification = generateToken();
    const verificationExpiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS);

    return this.db.withTransaction(async (client) => {
      const clash = await client.query<{ username: string; email: string | null }>(
        'SELECT username, email FROM users WHERE username = $1 OR email = $2',
        [username, email]
      );
      if (clash.rows.some((row) => row.username === username)) {
        throw new IdentityError(409, 'Username is already taken', 'USERNAME_TAKEN');
      }
      if (clash.rows.some((row) => row.email === email)) {
        throw new IdentityError(409, 'Email address is already registered', 'EMAIL_TAKEN');
      }

      let user!: UserRow;
      try {
        const inserted = await client.query<UserRow>(
          `INSERT INTO users (username, display_name, email, password_hash, role, activation_method, password_change_required)
           VALUES ($1, $2, $3, $4, 'STUDENT', 'SELF_REGISTER', FALSE)
           RETURNING *`,
          [username, displayName, email, passwordHash]
        );
        user = inserted.rows[0];
      } catch (err: unknown) {
        const constraint =
          err && typeof err === 'object' && 'constraint' in err && typeof err.constraint === 'string' ? err.constraint : '';
        if (constraint.includes('username')) {
          throw new IdentityError(409, 'Username is already taken', 'USERNAME_TAKEN');
        }
        if (constraint.includes('email')) {
          throw new IdentityError(409, 'Email address is already registered', 'EMAIL_TAKEN');
        }
        throw err;
      }

      await client.query(
        `INSERT INTO email_verification_tokens (user_id, token_hash, purpose, expires_at)
         VALUES ($1, $2, 'EMAIL_VERIFICATION', $3)`,
        [user.id, verification.hash, verificationExpiresAt]
      );

      const payload: Record<string, unknown> = {
        userId: user.id,
        username: user.username,
        email: user.email,
        expiresAt: verificationExpiresAt.toISOString(),
      };
      if (process.env.OANTUTI_DEV_EXPOSE_EMAIL_TOKENS === '1') {
        payload.token = verification.raw;
      }
      await client.query('INSERT INTO outbox_events (topic, payload) VALUES ($1, $2)', [
        'EMAIL_VERIFICATION_REQUESTED',
        JSON.stringify(payload),
      ]);

      return { user: this.toUserDto(user), emailVerificationRequired: true as const };
    });
  }

  /** Consumes a mailbox-confirmation token; the failure code is machine-readable. */
  async verifyEmail(token: string): Promise<{ verified: true }> {
    if (typeof token !== 'string' || token.length === 0) {
      throw new IdentityError(400, 'Verification token is required', 'EMAIL_VERIFICATION_INVALID');
    }
    const hash = hashToken(token);

    return this.db.withTransaction(async (client) => {
      const consumed = await client.query(
        `UPDATE email_verification_tokens
         SET consumed_at = clock_timestamp()
         WHERE token_hash = $1 AND purpose = 'EMAIL_VERIFICATION'
           AND consumed_at IS NULL AND expires_at > clock_timestamp()
         RETURNING id`,
        [hash]
      );
      if ((consumed.rowCount ?? 0) > 0) {
        return { verified: true as const };
      }

      const existing = await client.query<{ consumed_at: Date | null }>(
        `SELECT consumed_at FROM email_verification_tokens
         WHERE token_hash = $1 AND purpose = 'EMAIL_VERIFICATION'`,
        [hash]
      );
      const found = existing.rows[0];
      if (!found) {
        throw new IdentityError(400, 'Verification token is invalid', 'EMAIL_VERIFICATION_INVALID');
      }
      if (found.consumed_at) {
        throw new IdentityError(400, 'Verification token has already been used', 'EMAIL_VERIFICATION_CONSUMED');
      }
      throw new IdentityError(400, 'Verification token has expired', 'EMAIL_VERIFICATION_EXPIRED');
    });
  }

  /**
   * Starts e-mail recovery without disclosing whether the address is registered:
   * the caller answers 202 either way and a token exists only for known users.
   */
  async requestPasswordReset(email: string): Promise<void> {
    const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (normalized.length > 254 || !EMAIL_PATTERN.test(normalized)) {
      return;
    }
    const reset = generateToken();
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);

    await this.db.withTransaction(async (client) => {
      const found = await client.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [normalized]);
      const user = found.rows[0];
      if (!user) {
        return;
      }

      await client.query('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)', [
        user.id,
        reset.hash,
        expiresAt,
      ]);

      const payload: Record<string, unknown> = {
        userId: user.id,
        email: normalized,
        expiresAt: expiresAt.toISOString(),
      };
      if (process.env.OANTUTI_DEV_EXPOSE_EMAIL_TOKENS === '1') {
        payload.token = reset.raw;
      }
      await client.query('INSERT INTO outbox_events (topic, payload) VALUES ($1, $2)', [
        'PASSWORD_RESET_REQUESTED',
        JSON.stringify(payload),
      ]);
    });
  }

  /**
   * Redeems a one-use recovery token: rotates the password hash, clears the
   * forced-change flag and revokes every session the account still holds.
   */
  async resetPassword(token: string, newPassword: string): Promise<{ reset: true }> {
    if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
      throw new IdentityError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`, 'WEAK_PASSWORD');
    }
    if (typeof token !== 'string' || token.length === 0) {
      throw new IdentityError(400, 'Reset token is required', 'PASSWORD_RESET_INVALID');
    }
    const hash = hashToken(token);
    const newHash = await hashPassword(newPassword);

    return this.db.withTransaction(async (client) => {
      const consumed = await client.query<{ user_id: string }>(
        `UPDATE password_reset_tokens
         SET consumed_at = clock_timestamp()
         WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > clock_timestamp()
         RETURNING user_id`,
        [hash]
      );
      const row = consumed.rows[0];
      if (!row) {
        const existing = await client.query<{ consumed_at: Date | null }>(
          'SELECT consumed_at FROM password_reset_tokens WHERE token_hash = $1',
          [hash]
        );
        const found = existing.rows[0];
        if (!found) {
          throw new IdentityError(400, 'Reset token is invalid', 'PASSWORD_RESET_INVALID');
        }
        if (found.consumed_at) {
          throw new IdentityError(400, 'Reset token has already been used', 'PASSWORD_RESET_CONSUMED');
        }
        throw new IdentityError(400, 'Reset token has expired', 'PASSWORD_RESET_EXPIRED');
      }

      await client.query(
        `UPDATE users SET password_hash = $1, password_change_required = FALSE, updated_at = clock_timestamp()
         WHERE id = $2`,
        [newHash, row.user_id]
      );
      await client.query('UPDATE sessions SET revoked_at = clock_timestamp() WHERE user_id = $1 AND revoked_at IS NULL', [
        row.user_id,
      ]);

      return { reset: true as const };
    });
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
    if (!newPassword || newPassword.length < 8) {
      throw new IdentityError(400, 'New password must be at least 8 characters');
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

      const newHash = await hashPassword(newPassword);
      await client.query(
        'UPDATE users SET password_hash = $1, password_change_required = FALSE, updated_at = clock_timestamp() WHERE id = $2',
        [newHash, userId]
      );

      // Revoke all existing sessions (including the temporary change-password session)
      await client.query('UPDATE sessions SET revoked_at = clock_timestamp() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);

      // Issue fresh FULL session
      const { raw, hash } = generateToken();
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
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
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
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
         WHERE id = $1 AND revoked_at IS NULL AND expires_at > clock_timestamp()
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
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > clock_timestamp()
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
        AND s.revoked_at IS NULL
        AND s.expires_at > clock_timestamp()
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
    }>(query, [hash]);

    const row = res.rows[0];
    if (!row) {
      return undefined;
    }

    // Lookup user's team memberships
    const teamRes = await this.db.query<{ team_id: string }>(
      'SELECT team_id FROM team_memberships WHERE user_id = $1',
      [row.user_id]
    );
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
