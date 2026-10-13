import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createApp, type AppContext } from '../src/app.js';
import { unpackReplay } from '@oantuti/protocol';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const contexts: AppContext[] = [];
const directories: string[] = [];
function directory(): string { const dir = mkdtempSync(join(tmpdir(), 'oantuti-account-')); directories.push(dir); return dir; }
async function setup(dir = directory()): Promise<AppContext> {
  const context = await createApp({ dbLocation: join(dir, 'arena.db'), botsDir: join(dir, 'bots'), replaysDir: join(dir, 'replays') });
  contexts.push(context);
  return context;
}
async function register(context: AppContext, username: string) {
  const response = await context.app.inject({ method: 'POST', url: '/api/auth/register', payload: { username, email: `${username}@example.com`, password: 'correct horse battery staple' } });
  expect(response.statusCode).toBe(201);
  return { cookie: String(response.headers['set-cookie']).split(';')[0], user: response.json().user as { id: string; role: string } };
}
afterEach(async () => {
  for (const context of contexts.splice(0)) { await context.app.close(); context.db.close(); }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Accounts and owned immutable bot revisions', () => {
  it('hashes passwords and session tokens, persists sessions, and revokes them across restarts', async () => {
    const dir = directory();
    const context = await setup(dir);
    const { cookie, user } = await register(context, 'alice');
    expect(user.role).toBe('PLAYER');
    const stored = context.db.getUserById(user.id)!;
    expect(stored.password_hash).toMatch(/^scrypt\$/);
    expect(stored.password_hash).not.toContain('correct horse');
    expect(String((await context.app.inject({ url: '/api/auth/me', headers: { cookie } })).body)).not.toContain('password_hash');
    const raw = new DatabaseSync(join(dir, 'arena.db'));
    const session = raw.prepare('SELECT token_hash FROM sessions').get() as { token_hash: string };
    expect(session.token_hash).toBe(createHash('sha256').update(cookie.split('=')[1]).digest('hex'));
    raw.close();
    await context.app.close(); context.db.close(); contexts.splice(contexts.indexOf(context), 1);
    const restarted = await setup(dir);
    expect((await restarted.app.inject({ url: '/api/auth/me', headers: { cookie } })).json().user.id).toBe(user.id);
    expect((await restarted.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, 'content-type': 'application/json' }, payload: {} })).statusCode).toBe(204);
    await restarted.app.close(); restarted.db.close(); contexts.splice(contexts.indexOf(restarted), 1);
    const again = await setup(dir);
    expect((await again.app.inject({ url: '/api/auth/me', headers: { cookie } })).json()).toEqual({ user: null });
    expect((await again.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'incorrect password' } })).statusCode).toBe(401);
    expect((await again.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'correct horse battery staple' } })).statusCode).toBe(200);
  });

  it('validates auth payloads and blocks cross-origin mutations including forged forwarded headers', async () => {
    const context = await setup();
    for (const payload of [null, [], {}, { username: 'admin', email: 'a@example.com', password: 'long password', role: 'ADMIN' }]) {
      expect((await context.app.inject({ method: 'POST', url: '/api/auth/register', payload, headers: { 'content-type': 'application/json' } })).statusCode).toBe(400);
    }
    await register(context, 'alice');
    expect((await context.app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'alice', email: 'other@example.com', password: 'long password' } })).statusCode).toBe(409);
    const payload = { username: 'alice', password: 'correct horse battery staple' };
    for (const headers of [{ origin: 'https://evil.example' }, { origin: 'https://evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' }, { 'sec-fetch-site': 'cross-site' }]) {
      expect((await context.app.inject({ method: 'POST', url: '/api/auth/login', headers, payload })).statusCode).toBe(403);
    }
    expect((await context.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'http://localhost:80' }, payload })).statusCode).toBe(200);
    expect((await context.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'text/plain' }, payload: JSON.stringify(payload) })).statusCode).toBe(400);
  });

  it('enforces ownership, public source privacy, optimistic revisions, immutable files and soft deletion', async () => {
    const context = await setup();
    const alice = await register(context, 'alice'); const bob = await register(context, 'bob');
    const payload = { name: 'My Bot', language: 'PYTHON', sourceCode: 'print("revision one")' };
    expect((await context.app.inject({ method: 'POST', url: '/api/bots', payload })).statusCode).toBe(401);
    expect((await context.app.inject({ method: 'POST', url: '/api/bots', headers: { cookie: alice.cookie }, payload: { ...payload, filePath: '/etc/passwd' } })).statusCode).toBe(400);
    const created = await context.app.inject({ method: 'POST', url: '/api/bots', headers: { cookie: alice.cookie }, payload });
    expect(created.statusCode).toBe(201); const bot = created.json().bot;
    expect(bot).toMatchObject({ userId: alice.user.id, version: 1, isActive: true }); expect(bot.file_path).toBeUndefined();
    const oldPath = context.db.getBotById(bot.id)!.file_path!;
    const elo = context.db.getLeaderboard().find((entry) => entry.bot_id === bot.id);
    for (const request of [{ method: 'GET' as const, url: `/api/bots/${bot.id}` }, { method: 'GET' as const, url: `/api/bots/${bot.id}/versions` }, { method: 'PUT' as const, url: `/api/bots/${bot.id}`, payload: { ...payload, version: 1 } }, { method: 'DELETE' as const, url: `/api/bots/${bot.id}` }]) {
      expect((await context.app.inject({ ...request, headers: { cookie: bob.cookie } })).statusCode).toBe(404);
    }
    const system = context.db.listBots().find((entry) => entry.user_id === 'usr_system')!;
    expect((await context.app.inject({ method: 'DELETE', url: `/api/bots/${system.id}`, headers: { cookie: alice.cookie } })).statusCode).toBe(404);
    const list = await context.app.inject({ url: '/api/bots' }); expect(list.body).not.toContain('revision one'); expect(list.body).not.toContain('file_path'); expect(list.body).not.toContain('source_code');
    expect((await context.app.inject({ url: '/api/bots?mine=1' })).statusCode).toBe(401);
    expect((await context.app.inject({ url: '/api/bots?mine=1', headers: { cookie: alice.cookie } })).json().bots.map((entry: { id: string }) => entry.id)).toEqual([bot.id]);
    const changed = await context.app.inject({ method: 'PUT', url: `/api/bots/${bot.id}`, headers: { cookie: alice.cookie }, payload: { ...payload, version: 1, sourceCode: 'print("revision two")' } });
    expect(changed.statusCode).toBe(200); expect(changed.json().bot.version).toBe(2);
    expect(readFileSync(oldPath, 'utf8')).toBe(payload.sourceCode); expect(context.db.getBotById(bot.id)!.file_path).not.toBe(oldPath);
    expect((await context.app.inject({ method: 'PUT', url: `/api/bots/${bot.id}`, headers: { cookie: alice.cookie }, payload: { ...payload, version: 1 } })).statusCode).toBe(409);
    const versions = (await context.app.inject({ url: `/api/bots/${bot.id}/versions`, headers: { cookie: alice.cookie } })).json().versions;
    expect(versions.map((revision: { sourceCode: string }) => revision.sourceCode)).toEqual(['print("revision two")', payload.sourceCode]);
    expect(context.db.getLeaderboard().find((entry) => entry.bot_id === bot.id)).toEqual(elo);
    expect((await context.app.inject({ method: 'POST', url: '/api/bots', headers: { cookie: bob.cookie }, payload })).statusCode).toBe(201);
    const historicalMatch = context.db.createMatch({ mapId: 'sample-donut', whiteBotId: bot.id, blackBotId: system.id });
    expect((await context.app.inject({ method: 'DELETE', url: `/api/bots/${bot.id}`, headers: { cookie: alice.cookie } })).statusCode).toBe(204);
    expect(context.db.getBotById(bot.id)!.is_active).toBe(0); expect(context.db.getMatchById(historicalMatch.id)).toBeDefined();
    expect((await context.app.inject({ url: `/api/bots/${bot.id}/versions`, headers: { cookie: alice.cookie } })).json().versions).toHaveLength(2);
    expect(context.db.listBots().some((entry) => entry.id === bot.id)).toBe(false);
    expect(readdirSync(join(directories[0], 'bots'))).toHaveLength(3);
  });

  it('protects match/tournament creation and validates untrusted runtime payloads without leaking paths', async () => {
    const context = await setup(); const { cookie } = await register(context, 'alice');
    const adminRes = await context.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin123' } });
    const adminCookie = String(adminRes.headers['set-cookie']).split(';')[0];
    for (const url of ['/api/matches', '/api/matches/test', '/api/tournaments']) {
      expect((await context.app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(401);
      const callerCookie = url === '/api/tournaments' ? adminCookie : cookie;
      for (const payload of [null, [], { maxTurns: '5' }, { mapId: '../../etc/passwd', sourceCode: 4 }]) {
        const response = await context.app.inject({ method: 'POST', url, headers: { cookie: callerCookie, 'content-type': 'application/json' }, payload });
        expect(response.statusCode).toBe(400); expect(response.body).not.toContain(process.cwd());
      }
    }
  });
  it('migrates legacy database columns and history without dropping users, bots, matches or ELO', async () => {
    const dir = directory();
    const original = await setup(dir);
    const user = original.db.createUser({ username: 'legacy', email: 'legacy@example.com', password_hash: 'retained-legacy-hash' });
    const bot = original.db.createBot({ userId: user.id, name: 'Legacy Bot', language: 'PYTHON', sourceCode: 'print("legacy source")' });
    const match = original.db.createMatch({ mapId: 'sample-donut', whiteBotId: bot.id, blackBotId: bot.id });
    const elo = original.db.getLeaderboard().find((entry) => entry.bot_id === bot.id);
    await original.app.close(); original.db.close(); contexts.splice(contexts.indexOf(original), 1);
    const raw = new DatabaseSync(join(dir, 'arena.db'));
    raw.exec('DROP TABLE sessions; DROP TABLE bot_versions; ALTER TABLE matches DROP COLUMN creator_id; ALTER TABLE bots DROP COLUMN file_path; ALTER TABLE replays DROP COLUMN replay_data;');
    raw.close();
    const migrated = await setup(dir);
    expect(migrated.db.getUserById(user.id)).toEqual(user);
    expect(migrated.db.getBotById(bot.id)).toMatchObject({ ...bot, file_path: expect.any(String) });
    expect(readFileSync(migrated.db.getBotById(bot.id)!.file_path!, 'utf8')).toBe(bot.source_code);
    expect(migrated.db.listBotVersions(bot.id)).toMatchObject([{ version: 1, sourceCode: bot.source_code }]);
    expect(migrated.db.getMatchById(match.id)).toEqual(match);
    expect(migrated.db.getLeaderboard().find((entry) => entry.bot_id === bot.id)).toEqual(elo);
  });

  it('runs the current HTTP draft buffer with public active reads and no registry or ELO pollution', async () => {
    const context = await setup(); const { cookie } = await register(context, 'alice');
    const opponent = context.db.listBots().find((bot) => bot.name === 'RandomBot')!;
    const bots = context.db.listBots(); const ladder = context.db.getLeaderboard();
    const sourceCode = `import sys, json
for line in sys.stdin:
    message = json.loads(line)
    if message['type'] == 'INIT':
        print(json.dumps({'status': 'READY'}), flush=True)
    elif message['type'] == 'TURN':
        print(json.dumps({'action': 'MOVE', 'piece_id': 1, 'target': [0, 2]}), flush=True)
`;
    const response = await context.app.inject({ method: 'POST', url: '/api/matches/test', headers: { cookie }, payload: { mapId: 'sample-donut', opponentBotId: opponent.id, language: 'PYTHON', sourceCode, maxTurns: 1 } });
    expect(response.statusCode).toBe(200); const { matchId } = response.json();
    const live = await context.app.inject({ url: `/api/matches/${matchId}` });
    expect(live.statusCode).toBe(200); expect(live.json().isLive).toBe(true);
    expect(live.body).not.toContain(sourceCode); expect(live.body).not.toContain('file_path');
    await context.matchService.waitForMatch(matchId);
    const completed = await context.app.inject({ url: `/api/matches/${matchId}` });
    expect(completed.json().isLive).toBe(false);
    const replay = await context.app.inject({ url: `/api/matches/${matchId}/replay` });
    expect(replay.statusCode).toBe(200);
    expect(unpackReplay(replay.rawPayload).deltas[0].action?.targetPos).toEqual({ x: 0, y: 2 });
    expect(context.db.listBots()).toEqual(bots); expect(context.db.getLeaderboard()).toEqual(ladder);
    expect(context.db.getMatchById(matchId)).toBeUndefined(); expect(context.db.getReplayByMatchId(matchId)).toBeUndefined();
    expect(readdirSync(join(directories[0], 'replays'))).toEqual([]);
  });

});
