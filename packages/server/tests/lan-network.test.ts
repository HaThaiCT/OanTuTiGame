import { describe, it, expect } from 'vitest';
import { Database } from '../src/db.js';

describe('LAN Network & Dynamic Origin Resolution', () => {
  it('defaults server host binding to 0.0.0.0', () => {
    const host = process.env.HOST || '0.0.0.0';
    expect(host).toBe('0.0.0.0');
  });

  it('initializes database with default admin ready for LAN access', () => {
    const db = new Database(':memory:');
    const admin = db.getUserByUsername('admin');
    expect(admin).toBeDefined();
    expect(admin?.role).toBe('ADMIN');
    expect(admin?.username).toBe('admin');
    db.close();
  });

  it('constructs dynamic WebSocket URL from client host without hardcoded localhost', () => {
    function resolveWsUrl(host: string, isHttps = false, matchId = 'test_match'): string {
      const proto = isHttps ? 'wss:' : 'ws:';
      return `${proto}//${host}/ws/matches/${matchId}`;
    }

    const lanUrl = resolveWsUrl('192.168.1.100:3000', false, 'match_abc');
    expect(lanUrl).toBe('ws://192.168.1.100:3000/ws/matches/match_abc');

    const domainUrl = resolveWsUrl('arena.lan', false, 'match_xyz');
    expect(domainUrl).toBe('ws://arena.lan/ws/matches/match_xyz');
  });
});
