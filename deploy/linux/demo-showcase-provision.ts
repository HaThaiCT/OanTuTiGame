import { buildShowcaseIdentities, buildShowcaseCourses } from './demo-showcase-identities.js';
import { buildShowcaseMap } from './demo-showcase-assets.js';

export interface ShowcaseCredentials {
  readonly version: 1;
  readonly accounts: Record<string, { readonly userId: string; readonly password: string; readonly previousPassword?: string }>;
}
export type ShowcaseProvisionApi = (method: string, path: string, body?: unknown) => Promise<{ readonly status: number; readonly body: unknown }>;
export type ShowcaseProvisionDb = (sql: string, params?: readonly unknown[]) => Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
export interface ShowcaseProvisionOptions {
  readonly tag: string;
  readonly api: ShowcaseProvisionApi;
  readonly db: ShowcaseProvisionDb;
  readonly credentials: ShowcaseCredentials;
  readonly reauthenticateAdmin: () => Promise<void>;
  readonly persistCredentials: (credentials: ShowcaseCredentials) => Promise<void>;
  readonly checkpoint: (phase: string, ids: Readonly<Record<string, string>>) => Promise<void>;
}
export interface ShowcaseProvisionResult {
  readonly courseIds: readonly string[];
  readonly teamIds: readonly string[];
  readonly mapSlugs: readonly string[];
  readonly credentials: ShowcaseCredentials;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function responseRecord(body: unknown, field?: string): Record<string, unknown> {
  const outer = record(body);
  const value = field ? record(outer?.[field]) : outer;
  if (!value) throw new Error('showcase API returned an invalid response');
  return value;
}
async function writeApi(api: ShowcaseProvisionApi, method: string, path: string, body: unknown): Promise<unknown> {
  const response = await api(method, path, body);
  if (response.status < 200 || response.status >= 300) throw new Error(`${method} ${path} returned HTTP ${response.status}`);
  return response.body;
}
function id(row: Record<string, unknown> | undefined, label: string): string {
  if (typeof row?.id !== 'string' || row.id.length === 0) throw new Error(`showcase could not reconcile ${label} id`);
  return row.id;
}

function canonical(value: unknown): string {
  const normalize=(item:unknown):unknown=>Array.isArray(item)?item.map(normalize):item!==null&&typeof item==='object'?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b)).map(([key,child])=>[key,normalize(child)])):item;
  return JSON.stringify(normalize(value));
}
export async function provisionShowcaseBase(options: ShowcaseProvisionOptions): Promise<ShowcaseProvisionResult> {
  const { tag, api, db } = options;
  const identities = buildShowcaseIdentities(tag);
  const courses = buildShowcaseCourses(tag);
  const courseRows = await db('SELECT id,code,name FROM courses WHERE code=ANY($1::text[])', [courses.map((row) => row.code)]);
  const teamNames = identities.filter((identity) => identity.role === 'CAPTAIN').map((identity) => `${tag}_T${String(identity.teamSlot + 1).padStart(2, '0')}`);
  const teamRows = await db('SELECT t.id,t.name,t.course_id,t.captain_user_id,c.code AS course_code,array_agg(tm.user_id::text) AS members FROM teams t JOIN courses c ON c.id=t.course_id LEFT JOIN team_memberships tm ON tm.team_id=t.id WHERE t.name=ANY($1::text[]) GROUP BY t.id,c.code', [teamNames]);
  const teamsByName = new Map(teamRows.rows.map((row) => [String(row.name), row]));
  const mapSlugs = Array.from({ length: 12 }, (_, index) => `${tag.toLowerCase()}-map-${String(index + 1).padStart(2, '0')}`);
  const existingMapRows = await db('SELECT slug,display_name,descriptor FROM maps WHERE slug=ANY($1::text[])', [mapSlugs]);
  const existingMaps = new Map(existingMapRows.rows.map((row) => [String(row.slug), row]));
  const usernames = identities.map((identity) => identity.username);
  const knownUserRows = await db('SELECT id,username,display_name,role,activation_method FROM users WHERE username=ANY($1::text[])', [usernames]);
  const users = new Map(knownUserRows.rows.map((row) => [String(row.username), row]));
  for (const identity of identities) {
    const user = users.get(identity.username);
    if (user && (user.display_name !== identity.displayName || user.role !== 'STUDENT' || user.activation_method !== 'ADMIN_ISSUED')) {
      throw new Error(`existing account ${identity.username} is not a matching showcase-owned LAN student`);
    }
  }
  const coursesByCode = new Map(courseRows.rows.map((row) => [String(row.code), row]));
  for (const course of courses) {
    const existing = coursesByCode.get(course.code);
    if (existing && existing.name !== course.name) throw new Error(`existing showcase course ${course.code} has unexpected contents`);
  }
  for (let teamSlot = 0; teamSlot < 48; teamSlot++) {
    const teamName = teamNames[teamSlot];
    const existing = teamsByName.get(teamName);
    if (!existing) continue;
    const captain = identities[teamSlot * 2];
    const member = identities[teamSlot * 2 + 1];
    const captainId = users.get(captain.username)?.id;
    const memberId = users.get(member.username)?.id;
    const members = Array.isArray(existing.members) ? existing.members.filter((value): value is string => typeof value === 'string') : [];
    if (!captainId || !memberId || existing.course_code !== courses[Math.floor(teamSlot / 16)].code || existing.captain_user_id !== captainId || members.some((value) => value !== captainId && value !== memberId)) {
      throw new Error(`existing showcase team ${teamName} has unexpected ownership or membership`);
    }
  }
  for (let variant = 0; variant < 12; variant++) {
    const expected = buildShowcaseMap(variant, tag);
    const existing = existingMaps.get(expected.slug);
    if (existing && (existing.display_name !== expected.displayName || canonical(existing.descriptor) !== canonical(expected.descriptor))) {
      throw new Error(`existing showcase map ${expected.slug} has an unexpected descriptor`);
    }
  }
  const courseIds: string[] = [];
  for (const course of courses) {
    let row = coursesByCode.get(course.code);
    if (row && row.name !== course.name) throw new Error(`existing showcase course ${course.code} has unexpected contents`);
    if (!row) {
      const body = responseRecord(await writeApi(api, 'POST', '/api/v2/organizer/courses', { code: course.code, name: course.name }));
      row = { ...body, code: body.code ?? course.code, name: body.name ?? course.name };
      if (typeof row.id !== 'string') row = (await db('SELECT id,code,name FROM courses WHERE code=$1', [course.code])).rows[0];
      if (!row || row.code !== course.code || row.name !== course.name) throw new Error(`course ${course.code} was not durably created`);
    }
    courseIds.push(id(row, `course ${course.code}`));
    await options.checkpoint('COURSE_READY', { [course.code]: courseIds.at(-1)! });
  }

  const missing = identities.filter((identity) => !users.has(identity.username));
  const credentials: ShowcaseCredentials = { version: 1, accounts: { ...options.credentials.accounts } };
  if (missing.length) {
    try {
      const response = responseRecord(await writeApi(api, 'POST', '/api/v2/organizer/accounts/provision-lan', {
        users: missing.map((identity) => ({ username: identity.username, displayName: identity.displayName, role: 'STUDENT' })),
      }));
      const created = Array.isArray(response.created) ? response.created.map(record).filter((entry): entry is Record<string, unknown> => Boolean(entry)) : [];
      if (created.length !== missing.length) throw new Error('LAN provisioning returned an incomplete created-account list');
      for (const entry of created) {
        if (typeof entry.username !== 'string' || typeof entry.userId !== 'string' || typeof entry.temporaryPassword !== 'string') throw new Error('LAN provisioning returned an invalid account credential');
        credentials.accounts[entry.username] = { userId: entry.userId, password: entry.temporaryPassword };
      }
      for (const entry of created) {
        const username = String(entry.username);
        users.set(username, { id: String(entry.userId), username, display_name: String(entry.displayName), role: 'STUDENT', activation_method: 'ADMIN_ISSUED' });
      }
      await options.persistCredentials(credentials);
    } catch (cause) {
      const reconciled = await db('SELECT id,username,display_name,role,activation_method FROM users WHERE username=ANY($1::text[])', [usernames]);
      const reconciledUsers = new Map(reconciled.rows.map((row) => [String(row.username), row]));
      if (missing.some((identity) => !reconciledUsers.has(identity.username))) throw cause;
      users.clear();
      for (const [username, user] of reconciledUsers) users.set(username, user);
    }
  }
  for (const identity of identities) {
    const user = users.get(identity.username);
    if (!user || user.display_name !== identity.displayName || user.role !== 'STUDENT' || user.activation_method !== 'ADMIN_ISSUED') {
      throw new Error(`existing account ${identity.username} is not a matching showcase-owned LAN student`);
    }
    const stored = credentials.accounts[identity.username];
    if (stored?.userId === user.id && stored.password) continue;
    await options.reauthenticateAdmin();
    const reset = responseRecord(await writeApi(api, 'POST', `/api/v2/organizer/accounts/${encodeURIComponent(String(user.id))}/reset-password`, {}));
    if (reset.userId !== user.id || reset.username !== identity.username || typeof reset.temporaryPassword !== 'string') throw new Error(`password reset response did not match ${identity.username}`);
    credentials.accounts[identity.username] = { userId: String(user.id), password: reset.temporaryPassword };
    await options.persistCredentials(credentials);
  }

  const teamIds: string[] = [];
  for (let teamSlot = 0; teamSlot < 48; teamSlot++) {
    const teamName = teamNames[teamSlot];
    const course = courses[ Math.floor(teamSlot / 16) ];
    const captain = identities[teamSlot * 2];
    const member = identities[teamSlot * 2 + 1];
    const captainId: string = String(users.get(captain.username)!.id);
    const memberId: string = String(users.get(member.username)!.id);
    let team = teamsByName.get(teamName);
    if (team && (team.course_code !== course.code || team.captain_user_id !== captainId)) throw new Error(`existing showcase team ${teamName} has unexpected ownership`);
    if (!team) {
      const body = responseRecord(await writeApi(api, 'POST', '/api/v2/organizer/teams', { courseCode: course.code, name: teamName, captainUsername: captain.username }), 'team');
      team = { ...body, name: body.name ?? teamName, course_code: course.code, captain_user_id: captainId, members: [captainId] };
    }
    const teamId = id(team, `team ${teamName}`);
    const members = Array.isArray(team.members) ? team.members.filter((memberId): memberId is string => typeof memberId === 'string') : [];
    if (!members.includes(memberId)) {
      await writeApi(api, 'POST', `/api/v2/organizer/teams/${encodeURIComponent(teamId)}/members`, { userId: memberId });
    }
    teamIds.push(teamId);
    await options.checkpoint('TEAM_READY', { [teamName]: teamId });
  }

  for (let variant = 0; variant < 12; variant++) {
    const map = buildShowcaseMap(variant, tag);
    if (!existingMaps.has(map.slug)) await writeApi(api, 'POST', '/api/v2/organizer/maps', { slug: map.slug, displayName: map.displayName, descriptor: map.descriptor, visibility: 'PUBLIC' });
    await options.checkpoint('MAP_READY', { [map.slug]: map.slug });
  }
  return { courseIds, teamIds, mapSlugs, credentials };
}
