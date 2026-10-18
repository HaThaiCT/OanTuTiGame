#!/usr/bin/env -S /home/ha-thai/.local/bin/node --import tsx
/**
 * Local demo driver for the OanTuTi Arena rebuild stack.
 *
 * It exercises the **real** HTTP API of a running instance (no fixtures written behind the
 * server's back) and only touches PostgreSQL for two developer conveniences that no product
 * route offers: minting a session for an existing account (so a reviewer does not need the
 * account's password) and reading back state to wait for asynchronous work.
 *
 * Usage (from the repository root):
 *   npx tsx deploy/linux/dev-demo.ts seed   [--format SINGLE_ELIMINATION|SWISS_PLAYOFF|ROUND_ROBIN|ELO_ARENA] [--teams N] [--tag TAG] [--grace MINUTES]
 *   npx tsx deploy/linux/dev-demo.ts login  <username>
 *   npx tsx deploy/linux/dev-demo.ts status [--tag TAG]
 *
 * Environment:
 *   OANTUTI_API   base URL of the API      (default http://127.0.0.1:4301)
 *   OANTUTI_WEB   base URL of the portal   (default http://127.0.0.1:4300)
 *   PGHOST/PGPORT/PGUSER/PGDATABASE        PostgreSQL connection (defaults to the server's own
 *                                          resolution: env → development workspace file → defaults)
 *
 * `seed` is restartable: the course, the captain accounts, the teams and the demo map are created
 * once and reused; every run creates a fresh tournament so a previous run stays browsable.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { crc32 } from 'node:zlib';
import { resolveDbConfig, PostgresDatabase } from '../../packages/server/src/persistence/db.js';
import { generateTemporaryPassword, hashPassword } from '../../packages/server/src/identity/crypto.js';

const API = process.env.OANTUTI_API?.replace(/\/$/, '') ?? 'http://127.0.0.1:4301';
const WEB = process.env.OANTUTI_WEB?.replace(/\/$/, '') ?? 'http://127.0.0.1:4300';
const COOKIE = 'oantuti_session';

// ---------------------------------------------------------------------------------------------
// arguments

interface Options {
  readonly command: string;
  readonly positional: string[];
  readonly format: string;
  readonly teams: number;
  readonly tag: string;
  /** Grace before a finished round seals. 0 keeps a demo moving; the product default is 10 minutes. */
  readonly grace: number;
}

const FORMATS = ['SINGLE_ELIMINATION', 'SWISS_PLAYOFF', 'ROUND_ROBIN', 'ELO_ARENA'] as const;

function parseArgs(argv: readonly string[]): Options {
  const positional: string[] = [];
  let format = 'SINGLE_ELIMINATION';
  let teams = 2;
  let tag = 'DEMO';
  let grace = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--format') {
      format = (argv[++i] ?? '').toUpperCase();
      if (!FORMATS.includes(format as (typeof FORMATS)[number])) {
        throw new Error(`--format must be one of ${FORMATS.join(', ')}`);
      }
    } else if (arg === '--teams') {
      teams = Number.parseInt(argv[++i] ?? '', 10);
      if (!Number.isInteger(teams) || teams < 2 || teams > 16) throw new Error('--teams must be 2..16');
    } else if (arg === '--grace') {
      grace = Number.parseInt(argv[++i] ?? '', 10);
      if (!Number.isInteger(grace) || grace < 0 || grace > 1440) throw new Error('--grace must be 0..1440 minutes');
    } else if (arg === '--tag') {
      tag = (argv[++i] ?? '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
      if (!tag) throw new Error('--tag must contain letters or digits');
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  const command = positional.shift() ?? 'status';
  if (!['seed', 'login', 'status', 'accounts'].includes(command)) {
    throw new Error(`unknown command "${command}" (expected seed | login | status | accounts)`);
  }
  return { command, positional, format, teams, tag, grace };
}

// ---------------------------------------------------------------------------------------------
// HTTP helpers. Responses are parsed JSON of unknown shape, so every field is read through a
// narrow guard instead of an `any` cast.

interface ApiResult {
  readonly status: number;
  readonly body: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readString(source: Record<string, unknown> | null, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumber(source: Record<string, unknown> | null, key: string): number | undefined {
  const value = source?.[key];
  return typeof value === 'number' ? value : undefined;
}

function readArray(source: Record<string, unknown> | null, key: string): unknown[] {
  const value = source?.[key];
  return Array.isArray(value) ? value : [];
}

async function api(method: string, path: string, init?: { cookie?: string; body?: unknown }): Promise<ApiResult> {
  const headers: Record<string, string> = {};
  if (init?.cookie) headers.cookie = `${COOKIE}=${init.cookie}`;
  if (init?.body !== undefined) headers['content-type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      headers,
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch (error) {
    throw new Error(`API ${API} is not reachable (${error instanceof Error ? error.message : String(error)}); start it first`);
  }
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    /* keep the raw text */
  }
  return { status: response.status, body };
}

/** Fails loudly with the server's own error payload instead of a bare status code. */
async function apiOk(method: string, path: string, init?: { cookie?: string; body?: unknown }): Promise<Record<string, unknown> | null> {
  const result = await api(method, path, init);
  if (result.status >= 400) {
    const detail = typeof result.body === 'object' && result.body !== null ? JSON.stringify(result.body) : String(result.body);
    throw new Error(`${method} ${path} -> ${result.status} ${detail}`);
  }
  return asRecord(result.body);
}

const db = new PostgresDatabase(resolveDbConfig());

/** Mints a session row exactly like `IdentityService.login` does, and returns the raw token. */
async function mintSession(username: string, options: { reauth: boolean }): Promise<string> {
  const user = await db.query<{ id: string }>('SELECT id FROM users WHERE username = $1', [username]);
  if (user.rows.length === 0) throw new Error(`no account named "${username}" exists yet`);
  const raw = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(raw).digest('hex');
  await db.query(
    `INSERT INTO sessions (user_id, token_hash, scope, expires_at, reauthenticated_at)
     VALUES ($1, $2, 'FULL', now() + interval '4 hours', ${options.reauth ? 'now()' : 'NULL'})`,
    [user.rows[0].id, hash]
  );
  return raw;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(label: string, timeoutMs: number, probe: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: string | null = null;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== null) return value;
    last = `${Math.round((deadline - Date.now()) / 1000)}s left`;
    await sleep(2000);
  }
  throw new Error(`timed out waiting for ${label} (${last ?? 'no progress'})`);
}

// ---------------------------------------------------------------------------------------------
// A store-only ZIP writer: the upload route wants a real archive and we refuse to add a dependency
// for a handful of local demo files.

function zipStore(entries: readonly { path: string; data: Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8');
    const crc = crc32(entry.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, entry.data);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(entry.data.length, 20);
    dir.writeUInt32LE(entry.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42); // relative offset of the local header
    central.push(dir, name);
    offset += local.length + name.length + entry.data.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuffer, end]);
}

function starterZipBase64(): string {
  // The submission carries the standard library, the SDK and the project files; the starter bot
  // imports `oantuti`, so both files must be inside the archive.
  const files = ['starter_bot.py', 'oantuti.py'];
  const entries = files.map((name) => {
    const absolute = resolvePath(process.cwd(), 'sdk', 'python', name);
    if (!existsSync(absolute)) {
      throw new Error(`SDK file not found at ${absolute}; run this command from the repository root`);
    }
    return { path: name, data: readFileSync(absolute) };
  });
  return zipStore(entries).toString('base64');
}

// ---------------------------------------------------------------------------------------------
// demo world

interface DemoCaptain {
  readonly username: string;
  readonly teamId: string;
  readonly teamName: string;
  readonly password?: string;
}

interface DemoWorld {
  readonly courseCode: string;
  /** The pool the preset needs (4 for knockout/Swiss, 1 otherwise); the first one is committed. */
  readonly mapSlugs: string[];
  readonly captains: DemoCaptain[];
  readonly adminSession: string;
  readonly adminUsername: string;
}

/** Knockout and Swiss presets need four maps so a series never repeats a version; the rest need one. */
function requiredPoolSize(format: string): number {
  return format === 'SINGLE_ELIMINATION' || format === 'SWISS_PLAYOFF' ? 4 : 1;
}

const MAP_CORNERS: readonly [number, number][] = [
  [0, 0],
  [7, 0],
  [0, 7],
  [7, 7],
];

interface DemoMapSpec {
  readonly slug: string;
  readonly displayName: string;
  readonly whiteThrone: [number, number];
}

function demoMapSpecs(tag: string, format: string): DemoMapSpec[] {
  const prefix = tag.toLowerCase();
  return Array.from({ length: requiredPoolSize(format) }, (_, index) => ({
    slug: prefix + (requiredPoolSize(format) === 1 ? '-arena-8x8' : `-arena-8x8-${index + 1}`),
    displayName: `${tag} Arena 8x8 #${index + 1}`,
    whiteThrone: MAP_CORNERS[index % MAP_CORNERS.length] ?? [0, 0],
  }));
}

function demoTiles(): [number, number][] {
  const tiles: [number, number][] = [];
  for (let x = 0; x < 8; x += 1) for (let y = 0; y < 8; y += 1) tiles.push([x, y]);
  return tiles;
}

/** Three pieces of the three cyclic types, placed inwards from the throne that owns them. */
function piecesAround(
  throne: [number, number],
  owner: 'WHITE' | 'BLACK',
  firstId: number
): { id: number; owner: 'WHITE' | 'BLACK'; type: 'ROCK' | 'SCISSORS' | 'PAPER'; pos: [number, number] }[] {
  const [x, y] = throne;
  const stepX = x < 4 ? 1 : -1;
  const stepY = y < 4 ? 1 : -1;
  const spots: [number, number][] = [
    [x + stepX, y],
    [x, y + stepY],
    [x + stepX, y + stepY],
  ];
  const types = ['ROCK', 'SCISSORS', 'PAPER'] as const;
  return spots.map((pos, index) => ({ id: firstId + index, owner, type: types[index], pos }));
}

/** 8×8, all tiles valid, free thrones, full rock/scissors/paper per side: no validator warnings. */
function demoDescriptor(spec: DemoMapSpec) {
  const blackThrone: [number, number] = [7 - spec.whiteThrone[0], 7 - spec.whiteThrone[1]];
  return {
    mapName: spec.slug,
    width: 8,
    height: 8,
    validTiles: demoTiles(),
    whiteThrone: spec.whiteThrone,
    blackThrone,
    startingPieces: [...piecesAround(spec.whiteThrone, 'WHITE', 1), ...piecesAround(blackThrone, 'BLACK', 4)],
  };
}

async function teamIdByName(courseCode: string, teamName: string): Promise<string | undefined> {
  const team = await db.query<{ id: string }>(
    `SELECT t.id FROM teams t JOIN courses c ON c.id = t.course_id WHERE c.code = $1 AND t.name = $2`,
    [courseCode, teamName]
  );
  return team.rows[0]?.id;
}

async function ensureWorld(options: Options): Promise<DemoWorld> {
  const admins = await db.query<{ username: string }>(
    `SELECT username FROM users WHERE role = 'ADMIN' ORDER BY created_at LIMIT 1`
  );
  if (admins.rows.length === 0) throw new Error('no ADMIN account exists; bootstrap one before seeding a demo');
  const adminSession = await mintSession(admins.rows[0].username, { reauth: true });

  const courseCode = options.tag;
  const existingCourse = await db.query<{ id: string }>('SELECT id FROM courses WHERE code = $1', [courseCode]);
  if (existingCourse.rows.length === 0) {
    await apiOk('POST', '/api/v2/organizer/courses', { cookie: adminSession, body: { code: courseCode, name: `Lớp demo ${courseCode}` } });
  }

  // Captain accounts: provision only the missing ones, so a re-run keeps the same logins.
  const wanted = Array.from({ length: options.teams }, (_, index) => ({
    username: `${options.tag.toLowerCase()}_cap${index + 1}`,
    displayName: `Đội trưởng demo ${index + 1}`,
  }));
  const known = await db.query<{ username: string }>(
    'SELECT username FROM users WHERE username = ANY($1::text[])',
    [wanted.map((entry) => entry.username)]
  );
  const knownNames = new Set(known.rows.map((row) => row.username));
  const missing = wanted.filter((entry) => !knownNames.has(entry.username));
  const temporaryPasswords = new Map<string, string>();
  if (missing.length > 0) {
    const created = await apiOk('POST', '/api/v2/organizer/accounts/provision-lan', {
      cookie: adminSession,
      body: { users: missing.map((entry) => ({ username: entry.username, displayName: entry.displayName, role: 'STUDENT' })) },
    });
    for (const entry of readArray(created, 'created')) {
      const record = asRecord(entry);
      const username = readString(record, 'username');
      const password = readString(record, 'temporaryPassword');
      if (username && password) temporaryPasswords.set(username, password);
    }
  }

  // Teams, one per captain.
  const captains: DemoCaptain[] = [];
  for (let index = 0; index < wanted.length; index += 1) {
    const entry = wanted[index];
    const teamName = `Demo Team ${index + 1}`;
    let teamId = await teamIdByName(courseCode, teamName);
    if (teamId === undefined) {
      await apiOk('POST', '/api/v2/organizer/teams', {
        cookie: adminSession,
        body: { courseCode, name: teamName, captainUsername: entry.username },
      });
      teamId = await teamIdByName(courseCode, teamName);
    }
    if (teamId === undefined) throw new Error(`team "${teamName}" was created but could not be read back`);
    captains.push({ username: entry.username, teamId, teamName, password: temporaryPasswords.get(entry.username) });
  }

  // Demo maps, published once and reused. The preset decides how many the pool needs.
  const mapSpecs = demoMapSpecs(options.tag, options.format);
  for (const spec of mapSpecs) {
    const existing = await db.query<{ slug: string }>('SELECT slug FROM maps WHERE slug = $1', [spec.slug]);
    if (existing.rows.length === 0) {
      await apiOk('POST', '/api/v2/organizer/maps', {
        cookie: adminSession,
        body: { slug: spec.slug, displayName: spec.displayName, descriptor: demoDescriptor(spec), visibility: 'PUBLIC' },
      });
    }
  }

  return {
    courseCode,
    mapSlugs: mapSpecs.map((spec) => spec.slug),
    captains,
    adminSession,
    adminUsername: admins.rows[0].username,
  };
}

/** One block that works for every preset: state, games, rounds, encounters and (when it exists) standings. */
async function printTournamentSummary(tournamentId: string): Promise<void> {
  const state = await db.query<{ state: string; format: string }>('SELECT state, format FROM tournaments WHERE id = $1', [tournamentId]);
  const format = state.rows[0]?.format ?? '';
  const games = await db.query<{ status: string; count: string }>(
    `SELECT status, count(*)::text AS count FROM games
     WHERE encounter_id IN (SELECT id FROM encounters WHERE tournament_id = $1) GROUP BY status ORDER BY status`,
    [tournamentId]
  );
  const bracket = await apiOk('GET', `/api/v2/tournaments/${tournamentId}/bracket`);
  const standings = readArray(await apiOk('GET', `/api/v2/tournaments/${tournamentId}/standings`), 'standings');

  console.log(`  state       ${state.rows[0]?.state ?? '?'} · ${format} · games ${games.rows.map((row) => `${row.count} ${row.status}`).join(', ') || 'none'}`);
  for (const round of readArray(bracket, 'rounds')) {
    const record = asRecord(round);
    console.log(
      `  round       ${readString(record, 'stage')} #${readNumber(record, 'roundOrdinal')} · `
        + `${readNumber(record, 'slotCount')} slot(s) · ${readString(record, 'status')}`
    );
  }
  for (const encounter of readArray(bracket, 'encounters')) {
    const record = asRecord(encounter);
    const a = readString(record, 'team_a_name') ?? '?';
    const b = readString(record, 'team_b_name') ?? '?';
    const winnerId = readString(record, 'winner_team_id');
    const winner = winnerId === undefined ? '—' : winnerId === readString(record, 'team_a_id') ? a : b;
    console.log(
      `  encounter   ${a} ${readString(record, 'points_a') ?? '0'} : ${readString(record, 'points_b') ?? '0'} ${b} · `
        + `${readArray(record, 'games').length} game(s) · winner ${winner}`
    );
  }
  if (standings.length === 0) {
    const hasStandings = format === 'ROUND_ROBIN' || format === 'SWISS_PLAYOFF' || format === 'ELO_ARENA';
    console.log(
      hasStandings
        ? '  standings   chưa có snapshot — vòng đấu chưa seal (grace: POST …/grace, hoặc --grace 0 khi seed)'
        : '  standings   thể thức loại trực tiếp không có bảng xếp hạng — theo dõi nhánh đấu ở trên'
    );
  } else {
    for (const entry of standings) {
      const row = asRecord(entry);
      console.log(
        `  standings   #${readNumber(row, 'rank') ?? '-'} ${readString(row, 'team_name') ?? '?'} · `
          + `${readString(row, 'points') ?? '0'} pts · ${readNumber(row, 'wins') ?? 0}W/${readNumber(row, 'draws') ?? 0}D/${readNumber(row, 'losses') ?? 0}L · `
          + `Elo ${readString(row, 'rating_elo') ?? '-'}`
      );
    }
  }
}

async function seed(options: Options): Promise<void> {
  console.log(`API ${API} · portal ${WEB}`);
  const world = await ensureWorld(options);

  const tournamentName = `${options.tag} ${options.format.replace('_', ' ')} ${new Date().toISOString().slice(0, 16)}`;
  const created = await apiOk('POST', '/api/v2/organizer/tournaments', {
    cookie: world.adminSession,
    body: { courseCode: world.courseCode, name: tournamentName, format: options.format, maxTeams: Math.max(2, options.teams) },
  });
  const tournamentId = readString(asRecord(created?.tournament), 'id') ?? readString(created, 'id');
  if (!tournamentId) throw new Error('the tournament was created but the response carried no id');
  console.log(`tournament  ${tournamentId}  "${tournamentName}" (${options.format})`);

  for (const slug of world.mapSlugs) {
    await apiOk('POST', `/api/v2/organizer/tournaments/${tournamentId}/map-pool`, { cookie: world.adminSession, body: { slug } });
  }
  await apiOk('POST', `/api/v2/organizer/tournaments/${tournamentId}/map-commitment`, {
    cookie: world.adminSession,
    body: { slug: world.mapSlugs[0] },
  });
  // The grace period is part of the policy frozen at registration opening, so the organizer sets it
  // while the tournament is still DRAFT. The product default is 10 minutes; a demo wants to watch the
  // round seal (and the standings appear) within seconds. Zero does not bypass disputes or blockers.
  await apiOk('POST', `/api/v2/organizer/tournaments/${tournamentId}/grace`, {
    cookie: world.adminSession,
    body: { minutes: options.grace },
  });
  await apiOk('POST', `/api/v2/organizer/tournaments/${tournamentId}/publish`, { cookie: world.adminSession, body: {} });
  await apiOk('POST', `/api/v2/organizer/tournaments/${tournamentId}/open-registration`, { cookie: world.adminSession, body: {} });
  for (const captain of world.captains) {
    await apiOk('POST', `/api/v2/organizer/tournaments/${tournamentId}/enroll`, { cookie: world.adminSession, body: { teamId: captain.teamId } });
  }
  console.log(`enrolled    ${world.captains.map((entry) => entry.teamName).join(', ')}`);

  // Each team submits the SDK starter bot through its own captain session — the same route a
  // student uses — then we wait until the build is READY (never assume it is instantaneous).
  const zipBase64 = starterZipBase64();
  for (const captain of world.captains) {
    const session = await mintSession(captain.username, { reauth: true });
    const receipt = await apiOk('POST', `/api/v2/tournaments/${tournamentId}/submissions`, {
      cookie: session,
      body: { teamId: captain.teamId, language: 'PYTHON', entrypoint: 'starter_bot.py', zipBase64 },
    });
    const data = asRecord(receipt?.data) ?? receipt;
    console.log(`submitted   ${captain.teamName}  receipt #${readNumber(data, 'receiptOrdinal') ?? '?'}`);
  }

  await waitFor(`builds for ${world.captains.length} submissions`, 180_000, async () => {
    const rows = await db.query<{ status: string }>(
      `SELECT status FROM submissions WHERE tournament_id = $1 ORDER BY receipt_ordinal`,
      [tournamentId]
    );
    const statuses = rows.rows.map((row) => row.status);
    console.log(`  build       ${statuses.join(', ')}`);
    if (statuses.some((status) => status === 'REJECTED')) {
      throw new Error('a demo submission was rejected; check the uploaded zip and entrypoint');
    }
    return statuses.length >= world.captains.length && statuses.every((status) => status === 'READY') ? statuses : null;
  });

  await apiOk('POST', `/api/v2/organizer/tournaments/${tournamentId}/close-registration`, { cookie: world.adminSession, body: {} });
  await apiOk('POST', `/api/v2/organizer/tournaments/${tournamentId}/lock`, { cookie: world.adminSession, body: {} });
  await apiOk('POST', `/api/v2/organizer/tournaments/${tournamentId}/start`, {
    cookie: world.adminSession,
    body: { mapSlug: world.mapSlugs[0] },
  });
  console.log('started     the development auto-runner plays the round every 5 seconds');

  const played = await waitFor('the first round to finish and seal', 300_000, async () => {
    const stats = await db.query<{ total: string; completed: string; sealed: string | null; status: string | null }>(
      `SELECT
         (SELECT count(*) FROM games g WHERE g.encounter_id IN (SELECT id FROM encounters WHERE tournament_id = $1))::text AS total,
         (SELECT count(*) FROM games g WHERE g.status = 'COMPLETED' AND g.encounter_id IN (SELECT id FROM encounters WHERE tournament_id = $1))::text AS completed,
         (SELECT r.sealed_at::text FROM tournament_rounds r WHERE r.tournament_id = $1 AND r.round_ordinal = 1) AS sealed,
         (SELECT r.status FROM tournament_rounds r WHERE r.tournament_id = $1 AND r.round_ordinal = 1) AS status`,
      [tournamentId]
    );
    const total = Number(stats.rows[0].total);
    const completed = Number(stats.rows[0].completed);
    const sealed = stats.rows[0].sealed;
    if (total === 0) return null;
    console.log(`  games       ${completed}/${total} completed · round ${stats.rows[0].status ?? '?'}${sealed ? ' · sealed' : ''}`);
    return completed === total && total > 0 && sealed !== null ? { total, completed } : null;
  });

  const results = await db.query<{ game_id: string; winner: string | null; digest: string | null }>(
    `SELECT g.id AS game_id, rv.winner, rv.replay_digest AS digest
     FROM games g
     LEFT JOIN accepted_results ar ON ar.game_id = g.id
     LEFT JOIN result_versions rv ON rv.id = ar.result_version_id
     WHERE g.encounter_id IN (SELECT id FROM encounters WHERE tournament_id = $1)
     ORDER BY g.created_at, g.game_ordinal`,
    [tournamentId]
  );

  console.log('');
  console.log(`done        ${played.completed}/${played.total} games completed in round 1 (sealed)`);
  await printTournamentSummary(tournamentId);
  console.log('  note        the auto-runner keeps going: later rounds seal on their own, and only the final');
  console.log('              stage needs finalize after the appeal window (POST …/finalize)');
  console.log('');
  console.log('open in the portal');
  console.log(`  giải đấu     ${WEB}/tournaments/${tournamentId}`);
  console.log(`  trình chiếu  ${WEB}/projector/${tournamentId}`);
  const firstReplay = results.rows.find((row) => row.digest);
  if (firstReplay) console.log(`  replay       ${WEB}/replays?game=${firstReplay.game_id}`);
  console.log(`  tổ chức      ${WEB}/organizer`);
  console.log('');
  console.log('log in');
  console.log(`  admin        npx tsx deploy/linux/dev-demo.ts login ${world.adminUsername}`);
  for (const captain of world.captains) {
    console.log(`  ${captain.username.padEnd(12)} npx tsx deploy/linux/dev-demo.ts login ${captain.username}`);
    if (captain.password) console.log(`               (mật khẩu tạm, đổi ở lần đăng nhập đầu: ${captain.password})`);
  }
  await db.close();
}

async function login(options: Options): Promise<void> {
  const username = options.positional[0];
  if (!username) throw new Error('usage: dev-demo.ts login <username>');
  const token = await mintSession(username, { reauth: true });
  console.log(`session for "${username}" (valid 4 hours, re-auth stamped so destructive actions work)`);
  console.log('');
  console.log('paste in the browser DevTools console, then reload:');
  console.log(`  document.cookie = '${COOKIE}=${token}; path=/';`);
  console.log('');
  console.log(`or call the API with it:  curl -b '${COOKIE}=${token}' ${API}/api/v2/auth/me`);
  await db.close();
}

async function status(options: Options): Promise<void> {
  const tournaments = await db.query<{ id: string; name: string; state: string; format: string }>(
    `SELECT id, name, state, format FROM tournaments WHERE name LIKE $1 ORDER BY created_at DESC LIMIT 5`,
    [`${options.tag}%`]
  );
  if (tournaments.rows.length === 0) {
    console.log(`no tournament named "${options.tag} …" yet — run: npx tsx deploy/linux/dev-demo.ts seed`);
    await db.close();
    return;
  }
  for (const tournament of tournaments.rows) {
    console.log(`${tournament.name}  [${tournament.state}]  ${tournament.format}  ${tournament.id}`);
    await printTournamentSummary(tournament.id);
    console.log(`  ${WEB}/tournaments/${tournament.id}`);
  }
  await db.close();
}

async function accounts(options: Options): Promise<void> {
  const admin = await db.query<{ id: string; username: string }>(
    `SELECT id, username FROM users WHERE role = 'ADMIN' ORDER BY created_at LIMIT 1`
  );
  if (admin.rows.length === 0) throw new Error('no ADMIN account exists; bootstrap one before issuing demo credentials');

  const captains = await db.query<{ id: string; username: string; role: string }>(
    `SELECT id, username, role FROM users WHERE username LIKE $1 ORDER BY username`,
    [`${options.tag.toLowerCase()}_cap%`]
  );

  const targets = [
    { id: admin.rows[0].id, username: admin.rows[0].username, role: 'ADMIN' },
    ...captains.rows.map((row) => ({ id: row.id, username: row.username, role: row.role })),
  ];
  if (targets.length === 1) {
    console.log('chỉ có tài khoản ADMIN — chạy `npm run demo:seed` trước nếu muốn thêm tài khoản đội trưởng');
  }

  for (const target of targets) {
    const password = generateTemporaryPassword();
    const hash = await hashPassword(password);
    // The same shape the product uses for an admin-issued credential: a fresh one-time password that
    // must be changed at the next sign-in, plus revocation of every existing session.
    await db.query(
      `UPDATE users SET password_hash = $2, password_change_required = TRUE, updated_at = now() WHERE id = $1`,
      [target.id, hash]
    );
    await db.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [target.id]);
    await db.query(
      `INSERT INTO audit_events (actor_user_id, action, resource_type, resource_id, request_id, details)
       VALUES ($1, 'ADMIN_PASSWORD_RESET', 'user', $2, NULL, $3)`,
      [target.id, target.id, JSON.stringify({ username: target.username, mustChangePassword: true, source: 'DEV_DEMO_ACCOUNTS' })]
    );
    console.log(`  ${target.username.padEnd(14)} ${target.role.padEnd(8)} ${password}`);
  }

  console.log('');
  console.log('mật khẩu tạm — đổi ở lần đăng nhập đầu (đúng luồng ADMIN_ISSUED của sản phẩm);');
  console.log('mọi session cũ của các tài khoản này đã bị thu hồi, và mỗi lần cấp lại sẽ đổi mật khẩu.');
  console.log('muốn vào thẳng không đổi mật khẩu:  npm run demo:login <username>  rồi dán cookie vào DevTools');
  await db.close();
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  try {
    await db.query('SELECT 1');
  } catch (error) {
    throw new Error(
      `cannot reach PostgreSQL (${error instanceof Error ? error.message : String(error)}); export ` +
        'PGHOST/PGPORT/PGUSER/PGDATABASE for the rebuild workspace — see docs/implementation/rebuild/demo-and-tests.md'
    );
  }
  if (options.command === 'seed') return seed(options);
  if (options.command === 'login') return login(options);
  if (options.command === 'accounts') return accounts(options);
  return status(options);
}

main().catch(async (error: unknown) => {
  console.error(`dev-demo failed: ${error instanceof Error ? error.message : String(error)}`);
  await db.close().catch(() => undefined);
  process.exitCode = 1;
});
