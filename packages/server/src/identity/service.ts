import type { Database } from '../persistence/db.js';
import { hashPassword, verifyPassword, generateToken, generateTemporaryPassword, hashToken } from './crypto.js';
import type { Actor, Instant, Role, SessionScope, UUID } from '@oantuti/protocol';
import type { LanBulkUserEntry, LanProvisionedUser, SessionDto, UserDto } from '@oantuti/protocol';

export class IdentityError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = 'IdentityError';
  }
}

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

export class IdentityService {
  constructor(private readonly db: Database) {}

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
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        role: user.role,
        email: user.email ?? undefined,
        passwordChangeRequired: user.password_change_required,
        createdAt: user.created_at.toISOString(),
      },
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
