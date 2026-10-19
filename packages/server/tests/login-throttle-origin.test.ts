import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp, type AppContext } from '../src/app.js';
import { PostgresDatabase } from '../src/persistence/db.js';
import { hashToken } from '../src/identity/crypto.js';

/**
 * The login throttle is keyed by client address. Behind the LAN reverse proxy every socket carries
 * the proxy's address, so the API may only honour `X-Forwarded-For` for proxies the operator names:
 * untrusted, a caller could pick its own throttle bucket; always trusted, every client would share
 * one. `app.inject` uses 127.0.0.1 as the socket address, which is also the proxy address here.
 */
describe('login throttle client identity behind a proxy', () => {
  let db: PostgresDatabase;
  const usernames: string[] = [];

  const login = (app: AppContext['app'], username: string, forwardedFor: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v2/auth/login',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': forwardedFor },
      payload: { username, password: 'definitely-wrong-password' },
    });

  async function recordedIpKeys(names: readonly string[]): Promise<string[]> {
    const res = await db.query<{ ip_key: string }>(
      `SELECT ip_key FROM identity_login_attempts WHERE account_key = ANY($1::text[])`,
      [names.map((username) => hashToken(username))]
    );
    return res.rows.map((row) => row.ip_key);
  }

  beforeAll(async () => {
    db = new PostgresDatabase();
  });

  afterAll(async () => {
    if (usernames.length > 0) {
      await db.query(`DELETE FROM identity_login_attempts WHERE account_key = ANY($1::text[])`, [
        usernames.map((username) => hashToken(username)),
      ]);
    }
    await db.close();
  });

  it('ignores a forwarded address when no proxy is trusted', async () => {
    delete process.env.OANTUTI_TRUSTED_PROXIES;
    const context = await createApp({ pgDb: db });
    try {
      await context.app.ready();
      const first = `throttle_untrusted_a_${Date.now()}`;
      const second = `throttle_untrusted_b_${Date.now()}`;
      usernames.push(first, second);

      expect((await login(context.app, first, '203.0.113.7')).statusCode).toBe(401);
      expect((await login(context.app, second, '198.51.100.9')).statusCode).toBe(401);

      // Both callers were counted under the socket address: a spoofed header buys no fresh bucket.
      const keys = await recordedIpKeys([first, second]);
      expect(keys).toHaveLength(2);
      expect(new Set(keys).size).toBe(1);
      expect(keys[0]).toBe(hashToken('127.0.0.1'));
    } finally {
      await context.app.close();
    }
  });

  it('honours the forwarded address only from a named proxy', async () => {
    process.env.OANTUTI_TRUSTED_PROXIES = '127.0.0.1';
    const context = await createApp({ pgDb: db });
    try {
      await context.app.ready();
      const first = `throttle_trusted_a_${Date.now()}`;
      const second = `throttle_trusted_b_${Date.now()}`;
      usernames.push(first, second);

      expect((await login(context.app, first, '203.0.113.7')).statusCode).toBe(401);
      expect((await login(context.app, second, '198.51.100.9')).statusCode).toBe(401);

      // Each client keeps its own bucket once the operator declares the proxy.
      const keys = await recordedIpKeys([first, second]);
      expect(keys).toHaveLength(2);
      expect(keys.sort()).toEqual([hashToken('198.51.100.9'), hashToken('203.0.113.7')].sort());
    } finally {
      await context.app.close();
      delete process.env.OANTUTI_TRUSTED_PROXIES;
    }
  });
});
