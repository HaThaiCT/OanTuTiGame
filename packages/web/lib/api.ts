import type { BotLanguage, LanBulkUserEntry, LanProvisionedUser, PrivateSourceDto, SubmissionStatus, UserDto, NewsPostDto, AdminNewsPostDto, StarterBotTemplateDto } from '@oantuti/protocol';
import { apiRequest, type ApiResult } from './client';
import type { GlobalLeaderboardDto, PublicTeamProfileDto, RatingDecisionReceipt, RatingReviewDto, TournamentRatingChangesDto, TournamentTeamRatingsDto } from '@oantuti/protocol';
import type { ReplayMapDescriptor } from './replay';

export type TournamentState =
  | 'DRAFT' | 'PUBLISHED' | 'REGISTRATION_OPEN' | 'VALIDATING_SUBMISSIONS'
  | 'LOCKED' | 'READY_TO_START' | 'RUNNING' | 'PAUSED' | 'PROVISIONAL'
  | 'FINALIZED' | 'ARCHIVED' | 'CANCELLED';

export interface TournamentSummary {
  id: string;
  name: string;
  format: 'SINGLE_ELIMINATION' | 'SWISS_PLAYOFF' | 'ROUND_ROBIN' | 'ELO_ARENA';
  state: TournamentState;
  version: number;
  isRated: boolean;
  globalRatingPolicy: 'ArenaContestRating/v1';
  rulesRevision: string;
  maxTeams: number;
  registrationClosesAt: string | null;
  startedAt: string | null;
  createdAt: string;
}

export interface StandingRow {
  rank: number;
  teamId: string;
  teamName: string;
  points: number | string;
  matchesPlayed: number;
  wins: number;
  draws: number;
  losses: number;
  buchholz?: number | string;
  ratingElo?: number | string;
  isQualified: boolean;
}

export interface TournamentEntry {
  id: string;
  teamId: string;
  teamName: string;
  status: string;
  seedOrdinal: number | null;
}

export interface TournamentRegistration {
  readonly id: string;
  readonly tournamentId: string;
  readonly teamId: string;
  readonly teamName: string;
  readonly status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  readonly version: number;
  readonly reason: string | null;
  readonly requestedAt: string;
  readonly reviewedAt: string | null;
  readonly canCancel: boolean;
  readonly canRequest: boolean;
  readonly members: readonly {
    readonly userId: string;
    readonly username: string;
    readonly displayName: string;
    readonly role: string;
  }[];
}

export function listTournamentRegistrations(tournamentId: string, options: ServerFetchOptions = {}): Promise<ApiResult<{ registrations: TournamentRegistration[] }>> {
  return apiRequest(`${API}/api/v2/tournaments/${encodeURIComponent(tournamentId)}/registrations`, {
    headers: options.cookie ? { cookie: options.cookie } : undefined,
  });
}

export function requestTournamentRegistration(tournamentId: string, input: { readonly teamId: string }): Promise<ApiResult<TournamentRegistration>> {
  return apiRequest(`/api/v2/tournaments/${encodeURIComponent(tournamentId)}/registrations`, { method: 'POST', body: input });
}

export function cancelTournamentRegistration(tournamentId: string, registrationId: string, input: { readonly expectedVersion: number }): Promise<ApiResult<TournamentRegistration>> {
  return apiRequest(`/api/v2/tournaments/${encodeURIComponent(tournamentId)}/registrations/${encodeURIComponent(registrationId)}/cancel`, { method: 'POST', body: input });
}

export function reviewTournamentRegistration(tournamentId: string, registrationId: string, input: { readonly decision: 'APPROVE' | 'REJECT'; readonly reason?: string; readonly expectedVersion: number }): Promise<ApiResult<TournamentRegistration>> {
  return apiRequest(`/api/v2/organizer/tournaments/${encodeURIComponent(tournamentId)}/registrations/${encodeURIComponent(registrationId)}/review`, { method: 'POST', body: input });
}

export interface MapSummary {
  slug: string;
  displayName: string;
  visibility: 'PUBLIC' | 'HIDDEN' | string;
  /** Latest published version ordinal of the map; absent on older API builds. */
  currentVersion?: number;
}

/** Map frozen onto a tournament; `version` pins the immutable map version used for play. */
export interface MapCommitment {
  tournamentId: string;
  mapId: string;
  slug: string;
  displayName: string;
  version: number;
  committedAt: string;
}

/** `POST …/map-commitment` acknowledgement — the API returns the pin, not the full map row. */
export interface MapCommitmentReceipt {
  tournamentId: string;
  slug: string;
  version: number;
  committedAt: string;
}

export interface SessionUser {
  username: string;
  displayName: string;
  role: string;
  scope: string;
  teamIds: string[];
}

export interface ServerFetchOptions {
  /** Forward the caller's session cookie so the API can answer with ADMIN-scoped data. */
  cookie?: string;
}

const API = typeof window === 'undefined' ? process.env.API_BASE ?? 'http://127.0.0.1:4301' : '';

function value(record: Record<string, unknown>, snake: string, camel: string): unknown {
  return record[camel] ?? record[snake];
}

/** `null`/`undefined`/empty-string collapse to `null` so absent API columns stay distinguishable. */
function nullableString(input: unknown): string | null {
  return input === null || input === undefined || input === '' ? null : String(input);
}

function numberValue(input: unknown): number {
  const parsed = typeof input === 'number' ? input : Number(input ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function listTournaments(options: ServerFetchOptions = {}): Promise<TournamentSummary[]> {
  try {
    const response = await fetch(`${API}/api/v2/tournaments`, {
      cache: 'no-store',
      headers: options.cookie ? { cookie: options.cookie } : undefined,
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as { tournaments?: Record<string, unknown>[] };
    return (payload.tournaments ?? []).map((row) => ({
      id: String(value(row, 'id', 'id')),
      name: String(value(row, 'name', 'name')),
      format: String(value(row, 'format', 'format')) as TournamentSummary['format'],
      state: String(value(row, 'state', 'state')) as TournamentState,
      version: numberValue(value(row, 'version', 'version') ?? 1),
      isRated: value(row, 'is_rated', 'isRated') === true,
      globalRatingPolicy: (value(row, 'global_rating_policy', 'globalRatingPolicy') ?? 'ArenaContestRating/v1') as 'ArenaContestRating/v1',
      rulesRevision: String(value(row, 'rules_revision', 'rulesRevision') ?? 'ArenaGameplay/v2'),
      maxTeams: numberValue(value(row, 'max_teams', 'maxTeams') ?? 500),
      registrationClosesAt: (value(row, 'registration_closes_at', 'registrationClosesAt') as string | null) ?? null,
      startedAt: (value(row, 'started_at', 'startedAt') as string | null) ?? null,
      createdAt: String(value(row, 'created_at', 'createdAt') ?? ''),
    }));
  } catch {
    return [];
  }
}

/** Maps the API exposes for the organizer's start control; ADMIN sees hidden maps too. */
export async function listMaps(options: ServerFetchOptions = {}): Promise<MapSummary[]> {
  try {
    const response = await fetch(`${API}/api/v2/maps`, {
      cache: 'no-store',
      headers: options.cookie ? { cookie: options.cookie } : undefined,
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as { maps?: Record<string, unknown>[] };
    return (payload.maps ?? [])
      .map((row) => {
        const currentVersion = value(row, 'current_version', 'currentVersion');
        return {
          slug: String(value(row, 'slug', 'slug') ?? ''),
          displayName: String(value(row, 'display_name', 'displayName') ?? ''),
          visibility: String(value(row, 'visibility', 'visibility') ?? 'PUBLIC'),
          currentVersion:
            currentVersion === null || currentVersion === undefined ? undefined : numberValue(currentVersion),
        };
      })
      .filter((map) => map.slug !== '');
  } catch {
    return [];
  }
}

/**
 * Map frozen onto a tournament (`null` when the tournament has none yet).
 * The API answers 404 for DRAFT/missing tournaments, which is reported as `null` too.
 */
export async function getMapCommitment(
  id: string,
  options: ServerFetchOptions = {}
): Promise<MapCommitment | null> {
  try {
    const response = await fetch(`${API}/api/v2/tournaments/${id}/map-commitment`, {
      cache: 'no-store',
      headers: options.cookie ? { cookie: options.cookie } : undefined,
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { commitment?: Record<string, unknown> | null };
    const row = payload.commitment;
    if (!row) return null;
    return {
      tournamentId: String(value(row, 'tournament_id', 'tournamentId') ?? id),
      mapId: String(value(row, 'map_id', 'mapId') ?? ''),
      slug: String(value(row, 'slug', 'slug') ?? ''),
      displayName: String(value(row, 'display_name', 'displayName') ?? ''),
      version: numberValue(value(row, 'version', 'version')),
      committedAt: String(value(row, 'committed_at', 'committedAt') ?? ''),
    };
  } catch {
    return null;
  }
}

/** Reads one published or revealed map descriptor from the API. */
export async function getMap(
  slug: string,
  options: ServerFetchOptions = {}
): Promise<ReplayMapDescriptor | null> {
  try {
    const response = await fetch(`${API}/api/v2/maps/${encodeURIComponent(slug)}`, {
      cache: 'no-store',
      headers: options.cookie ? { cookie: options.cookie } : undefined,
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as Record<string, unknown>;
    const map = (payload.map ?? payload) as Record<string, unknown>;
    const descriptor = (map.descriptor ?? map) as unknown;
    return descriptor && typeof descriptor === 'object' ? (descriptor as ReplayMapDescriptor) : null;
  } catch {
    return null;
  }
}

/**
 * Freezes a map onto a tournament. Client-side only: `next.config.ts` rewrites `/api` to the API,
 * whose CSRF guard requires `application/json` (handled by `apiRequest`).
 */
export function commitMap(tournamentId: string, slug: string): Promise<ApiResult<MapCommitmentReceipt>> {
  return apiRequest<MapCommitmentReceipt>(`/api/v2/organizer/tournaments/${tournamentId}/map-commitment`, {
    method: 'POST',
    body: { slug },
  });
}

/** One map in a tournament's pool (`GET /api/v2/organizer/tournaments/:id/map-pool`). */
export interface MapPoolEntry {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly visibility: string;
  readonly currentVersion: number;
}

export interface MapPoolView {
  readonly pool: MapPoolEntry[];
  /** Server-side advisory, e.g. `POOL_UNDER_FOUR` for knockout series. */
  readonly warnings: string[];
}

function normalizeMapPoolEntry(row: Record<string, unknown>): MapPoolEntry {
  return {
    id: String(row.id ?? ''),
    slug: String(row.slug ?? ''),
    displayName: String(value(row, 'display_name', 'displayName') ?? ''),
    visibility: String(row.visibility ?? 'PUBLIC'),
    currentVersion: numberValue(value(row, 'current_version', 'currentVersion') ?? 0),
  };
}

function normalizeMapPool(pool: unknown): MapPoolEntry[] {
  return Array.isArray(pool) ? (pool as Record<string, unknown>[]).map(normalizeMapPoolEntry) : [];
}

/** Server-side pool read for the organizer console (ADMIN cookie); `null` when unreadable. */
export async function getMapPool(
  tournamentId: string,
  options: ServerFetchOptions = {}
): Promise<MapPoolView | null> {
  try {
    const headers: Record<string, string> = {};
    if (options.cookie) headers.cookie = options.cookie;
    const response = await fetch(
      `${API}/api/v2/organizer/tournaments/${encodeURIComponent(tournamentId)}/map-pool`,
      { cache: 'no-store', headers }
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as { pool?: unknown; warnings?: unknown };
    return {
      pool: normalizeMapPool(payload.pool),
      warnings: Array.isArray(payload.warnings) ? payload.warnings.map((warning) => String(warning)) : [],
    };
  } catch {
    return null;
  }
}

async function mutateMapPool(
  method: 'POST' | 'DELETE',
  tournamentId: string,
  slug: string
): Promise<ApiResult<MapPoolEntry[]>> {
  const path =
    method === 'DELETE'
      ? `/api/v2/organizer/tournaments/${encodeURIComponent(tournamentId)}/map-pool/${encodeURIComponent(slug)}`
      : `/api/v2/organizer/tournaments/${encodeURIComponent(tournamentId)}/map-pool`;
  const result = await apiRequest<{ pool?: unknown }>(path, {
    method,
    ...(method === 'POST' ? { body: { slug } } : {}),
  });
  if (!result.ok) return { ok: false, status: result.status, data: null, message: result.message, code: result.code };
  return {
    ok: true,
    status: result.status,
    message: result.message,
    code: result.code,
    data: normalizeMapPool(result.data?.pool),
  };
}

export function addMapPoolEntry(tournamentId: string, slug: string): Promise<ApiResult<MapPoolEntry[]>> {
  return mutateMapPool('POST', tournamentId, slug);
}

export function removeMapPoolEntry(tournamentId: string, slug: string): Promise<ApiResult<MapPoolEntry[]>> {
  return mutateMapPool('DELETE', tournamentId, slug);
}

export async function getOrganizerSession(options: ServerFetchOptions = {}): Promise<SessionUser | null> {
  if (!options.cookie) return null;
  try {
    const response = await fetch(`${API}/api/v2/auth/me`, {
      cache: 'no-store',
      headers: { cookie: options.cookie },
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      user?: { username?: unknown; displayName?: unknown; display_name?: unknown; role?: unknown } | null;
      scope?: unknown;
      teamIds?: unknown;
    };
    if (!payload.user) return null;
    const username = String(payload.user.username ?? '');
    return {
      username,
      displayName: String(payload.user.displayName ?? payload.user.display_name ?? username),
      role: String(payload.user.role ?? ''),
      scope: String(payload.scope ?? 'FULL'),
      teamIds: Array.isArray(payload.teamIds) ? payload.teamIds.map((teamId) => String(teamId)) : [],
    };
  } catch {
    return null;
  }
}

/** `null` means the API could not be read — distinct from a known-empty entry list. */
export async function listTournamentEntries(
  id: string,
  options: ServerFetchOptions = {}
): Promise<TournamentEntry[] | null> {
  try {
    const response = await fetch(`${API}/api/v2/tournaments/${id}/entries`, {
      cache: 'no-store',
      headers: options.cookie ? { cookie: options.cookie } : undefined,
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { entries?: Record<string, unknown>[] };
    return (payload.entries ?? []).map((row) => {
      const seed = value(row, 'seed_ordinal', 'seedOrdinal');
      return {
        id: String(value(row, 'id', 'id')),
        teamId: String(value(row, 'team_id', 'teamId')),
        teamName: String(value(row, 'team_name', 'teamName') ?? 'Đội chưa đặt tên'),
        status: String(value(row, 'status', 'status')),
        seedOrdinal: seed === null || seed === undefined ? null : numberValue(seed),
      };
    });
  } catch {
    return null;
  }
}

/**
 * `tournaments` row → `TournamentSummary`. Shared by the server-rendered pages and the projector,
 * which polls the same endpoint from the browser.
 */
export function normalizeTournamentRow(row: unknown): TournamentSummary {
  const record = asRecord(row) ?? {};
  return {
    id: String(value(record, 'id', 'id')),
    name: String(value(record, 'name', 'name')),
    format: String(value(record, 'format', 'format')) as TournamentSummary['format'],
    state: String(value(record, 'state', 'state')) as TournamentState,
    version: numberValue(value(record, 'version', 'version') ?? 1),
    isRated: value(record, 'is_rated', 'isRated') === true,
    globalRatingPolicy: (value(record, 'global_rating_policy', 'globalRatingPolicy') ?? 'ArenaContestRating/v1') as 'ArenaContestRating/v1',
    rulesRevision: String(value(record, 'rules_revision', 'rulesRevision') ?? 'ArenaGameplay/v2'),
    maxTeams: numberValue(value(record, 'max_teams', 'maxTeams') ?? 500),
    registrationClosesAt: (value(record, 'registration_closes_at', 'registrationClosesAt') as string | null) ?? null,
    startedAt: (value(record, 'started_at', 'startedAt') as string | null) ?? null,
    createdAt: String(value(record, 'created_at', 'createdAt') ?? ''),
  };
}

export async function getTournament(id: string): Promise<TournamentSummary | null> {
  try {
    const response = await fetch(`${API}/api/v2/tournaments/${id}`, { cache: 'no-store' });
    if (!response.ok) return null;
    return normalizeTournamentRow(await response.json());
  } catch {
    return null;
  }
}

export interface StandingsSnapshot {
  stage: string;
  round: number;
  rows: StandingRow[];
}

/**
 * `GET …/standings` payload → rows. Shared by the server-rendered page and the projector, which
 * polls the same endpoint from the browser.
 */
export function normalizeStandingsPayload(payload: unknown): StandingsSnapshot {
  const record = asRecord(payload) ?? {};
  const rows = Array.isArray(record.standings) ? (record.standings as Record<string, unknown>[]) : [];
  return {
    stage: typeof record.stage === 'string' ? record.stage : 'MAIN',
    round: numberValue(record.roundOrdinal),
    rows: rows.map((row) => ({
      rank: numberValue(row.rank),
      teamId: String(value(row, 'team_id', 'teamId')),
      teamName: String(value(row, 'team_name', 'teamName') ?? 'Đội chưa đặt tên'),
      points: (value(row, 'points', 'points') as number | string) ?? 0,
      matchesPlayed: numberValue(value(row, 'matches_played', 'matchesPlayed')),
      wins: numberValue(value(row, 'wins', 'wins')),
      draws: numberValue(value(row, 'draws', 'draws')),
      losses: numberValue(value(row, 'losses', 'losses')),
      buchholz: value(row, 'buchholz', 'buchholz') as number | string | undefined,
      ratingElo: value(row, 'rating_elo', 'ratingElo') as number | string | undefined,
      isQualified: Boolean(value(row, 'is_qualified', 'isQualified')),
    })),
  };
}

export async function getStandings(id: string): Promise<StandingsSnapshot> {
  try {
    const response = await fetch(`${API}/api/v2/tournaments/${id}/standings`, { cache: 'no-store' });
    if (!response.ok) return { stage: 'MAIN', round: 0, rows: [] };
    return normalizeStandingsPayload(await response.json());
  } catch {
    return { stage: 'MAIN', round: 0, rows: [] };
  }
}

export interface BracketGame {
  gameId: string;
  gameOrdinal: number;
  status: string;
}

export interface BracketEncounter {
  encounterId: string;
  stage: string;
  roundOrdinal: number;
  slotOrdinal: number;
  teamAId: string;
  teamAName: string | null;
  teamBId: string | null;
  teamBName: string | null;
  status: string;
  winnerTeamId: string | null;
  pointsA: number | string;
  pointsB: number | string;
  /**
   * Games scheduled for this encounter (best-of series). `/api/v2/games/:id/result|replay`
   * links are rendered per game when the API returns them.
   */
  games: BracketGame[];
}

/**
 * `GET …/bracket` payload → encounters. Shared by the server-rendered page and the projector,
 * which polls the same endpoint from the browser.
 */
export function normalizeBracketPayload(payload: unknown): BracketEncounter[] {
  const record = asRecord(payload) ?? {};
  const rows = Array.isArray(record.encounters) ? (record.encounters as Record<string, unknown>[]) : [];
  return rows.map((row) => ({
    encounterId: String(value(row, 'encounter_id', 'encounterId') ?? ''),
    stage: String(value(row, 'stage', 'stage') ?? 'MAIN'),
    roundOrdinal: numberValue(value(row, 'round_ordinal', 'roundOrdinal')),
    slotOrdinal: numberValue(value(row, 'slot_ordinal', 'slotOrdinal')),
    teamAId: String(value(row, 'team_a_id', 'teamAId') ?? ''),
    teamAName: nullableString(value(row, 'team_a_name', 'teamAName')),
    teamBId: nullableString(value(row, 'team_b_id', 'teamBId')),
    teamBName: nullableString(value(row, 'team_b_name', 'teamBName')),
    status: String(value(row, 'status', 'status') ?? 'PENDING'),
    winnerTeamId: nullableString(value(row, 'winner_team_id', 'winnerTeamId')),
    pointsA: (value(row, 'points_a', 'pointsA') as number | string) ?? 0,
    pointsB: (value(row, 'points_b', 'pointsB') as number | string) ?? 0,
    games: Array.isArray(row.games)
      ? (row.games as Record<string, unknown>[])
          .map((game) => ({
            gameId: String(value(game, 'gameId', 'game_id') ?? ''),
            gameOrdinal: numberValue(value(game, 'gameOrdinal', 'game_ordinal')),
            status: String(value(game, 'status', 'status') ?? 'PENDING'),
          }))
          .filter((game) => game.gameId !== '')
      : [],
  }));
}

/**
 * One round's structure. `slotCount` is the bracket width, which can exceed the number of encounter
 * rows because two EMPTY slots produce no row at all.
 */
export interface BracketRound {
  stage: string;
  roundOrdinal: number;
  slotCount: number;
  status: string;
}

export interface BracketView {
  encounters: BracketEncounter[];
  rounds: BracketRound[];
}

export function normalizeBracketRounds(payload: unknown): BracketRound[] {
  const record = asRecord(payload) ?? {};
  const rows = Array.isArray(record.rounds) ? (record.rounds as Record<string, unknown>[]) : [];
  return rows.map((row) => ({
    stage: String(value(row, 'stage', 'stage') ?? 'MAIN'),
    roundOrdinal: numberValue(value(row, 'round_ordinal', 'roundOrdinal')),
    slotCount: numberValue(value(row, 'slot_count', 'slotCount')),
    status: String(value(row, 'status', 'status') ?? 'PENDING'),
  }));
}

/** `null` means the API could not be read — distinct from a tournament with no encounters yet. */
export async function getBracket(id: string): Promise<BracketView | null> {
  try {
    const response = await fetch(`${API}/api/v2/tournaments/${id}/bracket`, { cache: 'no-store' });
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    return { encounters: normalizeBracketPayload(payload), rounds: normalizeBracketRounds(payload) };
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------------------------------------
 * Private tests — team-scoped practice runs of a bot against a baseline or an earlier submission.
 * They are strictly separate from official play: no receipt ordinal, no accepted result, no
 * standings/rating. The list and replay endpoints are session-scoped, so these helpers go through
 * the browser (relative `/api` paths + the Next rewrite) where the cookie is attached.
 * ------------------------------------------------------------------------------------------- */

/** Statuses the private-test pipeline reports; `RUNNING` is the only one a submission never has. */
export type PrivateTestStatus =
  | 'QUEUED' | 'COMPILING' | 'SMOKE_TESTING' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface PrivateTestOpponent {
  kind: string;
  label: string;
  submissionId: string | null;
}

export interface PrivateTestMapRef {
  name: string;
  version: number | null;
  source: string;
}

/** Winner side of a private test; the API sends the official-results number (1/2/0). */
export type PrivateTestWinner = 'WHITE' | 'BLACK' | 'DRAW' | 'UNKNOWN';

/** Played-match facts as sent by the API for a COMPLETED test; never synthesised locally. */
export interface PrivateTestOutcome {
  winner: PrivateTestWinner;
  reason: string;
  totalTurns: number;
  opponent: PrivateTestOpponent | null;
  map: PrivateTestMapRef | null;
  finishedAt: string | null;
}

/** `error` for a FAILED run, `played` for a COMPLETED one; the API sends `null` while pending. */
export type PrivateTestResult =
  | { kind: 'played'; outcome: PrivateTestOutcome }
  | { kind: 'error'; error: string };

export interface PrivateTestSummary {
  id: string;
  status: string;
  language: string;
  entrypoint: string;
  sourceDigest: string;
  createdAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  result: PrivateTestResult | null;
  replayDigest: string | null;
  buildError: string | null;
}

/** `POST …/private-tests` acknowledgement — the run is queued, not finished. */
export interface PrivateTestReceipt {
  receiptId: string | null;
  timestamp: string | null;
  testId: string | null;
  status: string | null;
  queuedAt: string | null;
  sourceDigest: string | null;
}

export interface PrivateTestUpload {
  teamId: string;
  language: string;
  entrypoint: string;
  zipBase64: string;
}

function asRecord(input: unknown): Record<string, unknown> | null {
  return input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : null;
}

/** First non-null hit across the sources, camelCase key first (the API has shipped both). */
function field(sources: (Record<string, unknown> | null)[], ...keys: string[]): unknown {
  for (const source of sources) {
    if (!source) continue;
    for (const key of keys) {
      const found = source[key];
      if (found !== undefined && found !== null) return found;
    }
  }
  return null;
}

/**
 * `result_payload.winner` is the official-results side number (1 = WHITE, 2 = BLACK, 0 = draw);
 * side names are accepted too so a later API revision cannot break the panel.
 */
function normalizePrivateTestWinner(input: unknown): PrivateTestWinner {
  if (input === 1 || input === '1' || input === 'WHITE') return 'WHITE';
  if (input === 2 || input === '2' || input === 'BLACK') return 'BLACK';
  if (input === 0 || input === '0' || input === 'DRAW') return 'DRAW';
  return 'UNKNOWN';
}

function normalizePrivateTestResult(input: unknown): PrivateTestResult | null {
  const row = asRecord(input);
  if (!row) return null;
  const error = field([row], 'error', 'message');
  if (typeof error === 'string' && error.trim() !== '') return { kind: 'error', error };
  const winner = field([row], 'winner', 'winnerSide');
  if (winner === null) return null;
  const opponentRow = asRecord(field([row], 'opponent'));
  const mapRow = asRecord(field([row], 'map'));
  const version = mapRow ? field([mapRow], 'version') : null;
  const turns = field([row], 'totalTurns');
  return {
    kind: 'played',
    outcome: {
      winner: normalizePrivateTestWinner(winner),
      reason: String(field([row], 'reason') ?? ''),
      totalTurns: numberValue(turns ?? 0),
      opponent: opponentRow
        ? {
            kind: String(field([opponentRow], 'kind', 'type') ?? ''),
            label: String(field([opponentRow], 'label', 'name') ?? ''),
            submissionId: nullableString(field([opponentRow], 'submissionId')),
          }
        : null,
      map: mapRow
        ? {
            name: String(field([mapRow], 'name', 'mapName') ?? ''),
            version: version === null ? null : numberValue(version),
            source: String(field([mapRow], 'source') ?? ''),
          }
        : null,
      finishedAt: nullableString(field([row], 'finishedAt', 'completedAt')),
    },
  };
}

/** Rows without an id are dropped: the id is what keys the list and the replay link. */
function normalizePrivateTest(row: unknown): PrivateTestSummary | null {
  const record = asRecord(row);
  if (!record) return null;
  const id = field([record], 'id', 'testId');
  if (typeof id !== 'string' || id.trim() === '') return null;
  return {
    id,
    status: String(field([record], 'status') ?? ''),
    language: String(field([record], 'language') ?? ''),
    entrypoint: String(field([record], 'entrypoint') ?? ''),
    sourceDigest: String(field([record], 'sourceDigest') ?? ''),
    createdAt: nullableString(field([record], 'createdAt')),
    startedAt: nullableString(field([record], 'startedAt')),
    completedAt: nullableString(field([record], 'completedAt')),
    result: normalizePrivateTestResult(field([record], 'result')),
    replayDigest: nullableString(field([record], 'replayDigest')),
    buildError: nullableString(field([record], 'buildError')),
  };
}

/** The receipt has been observed both flat and nested under `data`; accept either shape. */
export function normalizePrivateTestReceipt(payload: unknown): PrivateTestReceipt {
  const top = asRecord(payload);
  const sources = [top, asRecord(top ? top.data : null)];
  return {
    receiptId: nullableString(field(sources, 'receiptId', 'id')),
    timestamp: nullableString(field(sources, 'timestamp', 'createdAt')),
    testId: nullableString(field(sources, 'testId')),
    status: nullableString(field(sources, 'status')),
    queuedAt: nullableString(field(sources, 'queuedAt')),
    sourceDigest: nullableString(field(sources, 'sourceDigest')),
  };
}

/**
 * Queues a private test run for a team. Client-side only: `apiRequest` sends `application/json`
 * (the API CSRF guard) through the Next rewrite, keeping the session cookie attached.
 */
export async function createPrivateTest(
  tournamentId: string,
  upload: PrivateTestUpload
): Promise<ApiResult<PrivateTestReceipt>> {
  const result = await apiRequest<unknown>(
    `/api/v2/tournaments/${encodeURIComponent(tournamentId)}/private-tests`,
    { method: 'POST', body: upload }
  );
  if (!result.ok) return { ok: false, status: result.status, data: null, message: result.message };
  return {
    ok: true,
    status: result.status,
    data: normalizePrivateTestReceipt(result.data),
    message: result.message,
  };
}

/** `data` is `null` on failure — distinct from a successful, known-empty test list. */
export async function listPrivateTests(
  tournamentId: string,
  teamId: string
): Promise<ApiResult<PrivateTestSummary[]>> {
  const result = await apiRequest<{ tests?: unknown[] }>(
    `/api/v2/tournaments/${encodeURIComponent(tournamentId)}/private-tests?teamId=${encodeURIComponent(teamId)}`
  );
  if (!result.ok) return { ok: false, status: result.status, data: null, message: result.message };
  const rows = Array.isArray(result.data?.tests) ? result.data.tests : [];
  return {
    ok: true,
    status: result.status,
    data: rows.map(normalizePrivateTest).filter((test): test is PrivateTestSummary => test !== null),
    message: result.message,
  };
}

/**
 * Same-origin replay URL for a test. The API answers with the replay binary when it stored one,
 * so this stays a plain link rather than a `fetch`.
 */
export function privateTestReplayUrl(testId: string): string {
  return `/api/v2/private-tests/${encodeURIComponent(testId)}/replay`;
}

/* ---------------------------------------------------------------------------------------------
 * Adjudication — disputes, result corrections, announcements and the appeal window.
 *
 * The dispute/correction writes go through `apiRequest` (relative `/api` paths + the Next rewrite)
 * so the browser session cookie stays attached; those endpoints require an ADMIN session and the
 * API CSRF guard requires `application/json`, which `apiRequest` sends. The announcements feed is
 * a public GET and is read on the server with `cache: 'no-store'`.
 * ------------------------------------------------------------------------------------------- */

/** `disputes` row (`007-disputes-and-corrections.sql`); snake_case columns are normalized. */
export interface DisputeRecord {
  id: string;
  tournamentId: string;
  encounterId: string;
  teamId: string;
  status: string;
  reason: string;
  decision: string | null;
  decidedByUserId: string | null;
  createdAt: string | null;
  resolvedAt: string | null;
}

/** Currently accepted result of a game — `revision` is what a correction preview must expect. */
export interface AcceptedResultRef {
  gameId: string;
  revision: number;
  disposition: string | null;
}

/** `POST …/preview-correction` answer: the impact description plus the digest `apply` must echo. */
export interface CorrectionPreview {
  gameId: string;
  encounterId: string;
  roundOrdinal: number;
  currentRevision: number;
  action: string;
  previewDigest: string;
  description: string;
  descendantEncounterIds: string[];
  affectedRounds: { stage: string; roundOrdinal: number }[];
  requiredRePair: boolean;
  requiredRebuild: boolean;
  ratingEventCount: number;
}

/** `POST …/apply-correction` receipt — `newRevision` is the revision the correction created. */
export interface CorrectionReceipt {
  receiptId: string | null;
  timestamp: string | null;
  gameId: string | null;
  newRevision: number | null;
  impactDigest: string | null;
  appliedAt: string | null;
}

/** `POST …/appeal-window` acknowledgement, echoing the minutes the server actually stored. */
export interface AppealWindowReceipt {
  tournamentId: string;
  finalAppealWindowMinutes: number;
}

/** `GET …/announcements` entry: one `outbox_events` row exposed to the portal. */
export interface Announcement {
  id: string;
  topic: string;
  createdAt: string | null;
  /** Opaque event payload; the timeline renders a short summary, never the raw object. */
  payload: Record<string, unknown> | null;
}

/** One bracket game flattened with its encounter context, for the dispute/correction pickers. */
export interface BracketGameOption {
  gameId: string;
  gameOrdinal: number;
  status: string;
  encounterId: string;
  encounterStatus: string;
  stage: string;
  roundOrdinal: number;
  slotOrdinal: number;
  teamAId: string;
  teamAName: string | null;
  teamBId: string | null;
  teamBName: string | null;
}

/** Body of both correction endpoints; `VOID` clears a result, `REJUDGE` supersedes it. */
export interface CorrectionCommandInput {
  action: 'VOID' | 'REJUDGE';
  reason: string;
  expectedRevision: number;
}

/**
 * `disputes` rows are returned straight from Postgres, so the columns stay snake_case; each field
 * also accepts the camelCase spelling so a future serializing route cannot break the panel.
 */
function normalizeDisputeRecord(row: unknown): DisputeRecord | null {
  const record = asRecord(row);
  if (!record) return null;
  const id = field([record], 'id');
  if (typeof id !== 'string' || id.trim() === '') return null;
  return {
    id,
    tournamentId: String(field([record], 'tournament_id', 'tournamentId') ?? ''),
    encounterId: String(field([record], 'encounter_id', 'encounterId') ?? ''),
    teamId: String(field([record], 'team_id', 'teamId') ?? ''),
    status: String(field([record], 'status') ?? ''),
    reason: String(field([record], 'reason') ?? ''),
    decision: nullableString(field([record], 'decision')),
    decidedByUserId: nullableString(field([record], 'decided_by_user_id', 'decidedByUserId')),
    createdAt: nullableString(field([record], 'created_at', 'createdAt')),
    resolvedAt: nullableString(field([record], 'resolved_at', 'resolvedAt')),
  };
}

/** Accepts the `{ disputes: [...] }` list envelope or a bare array; rows without an id are dropped. */
export function normalizeDisputeList(payload: unknown): DisputeRecord[] {
  const record = asRecord(payload);
  const rows = Array.isArray(payload) ? payload : Array.isArray(record?.disputes) ? record.disputes : [];
  return rows
    .map(normalizeDisputeRecord)
    .filter((dispute): dispute is DisputeRecord => dispute !== null);
}

/** The correction DTOs come from the service as camelCase; snake_case is accepted as well. */
function normalizeCorrectionPreview(payload: unknown): CorrectionPreview {
  const arrayValue = (input: unknown): unknown[] => Array.isArray(input) ? input : [];
  const record = asRecord(payload) ?? {};
  return {
    gameId: String(field([record], 'gameId', 'game_id') ?? ''),
    encounterId: String(field([record], 'encounterId', 'encounter_id') ?? ''),
    roundOrdinal: numberValue(field([record], 'roundOrdinal', 'round_ordinal')),
    currentRevision: numberValue(field([record], 'currentRevision', 'current_revision')),
    action: String(field([record], 'action') ?? ''),
    previewDigest: String(field([record], 'previewDigest', 'preview_digest') ?? ''),
    description: String(field([record], 'description') ?? ''),
    descendantEncounterIds: arrayValue(record.descendantEncounterIds ?? record.descendant_encounter_ids).map(String),
    affectedRounds: arrayValue(record.affectedRounds ?? record.affected_rounds).map((round) => {
      const item = asRecord(round) ?? {};
      return { stage: String(field([item], 'stage') ?? ''), roundOrdinal: numberValue(field([item], 'roundOrdinal', 'round_ordinal')) };
    }),
    requiredRePair: field([record], 'requiredRePair', 'required_re_pair') === true,
    requiredRebuild: field([record], 'requiredRebuild', 'required_rebuild') === true,
    ratingEventCount: arrayValue(asRecord(record.ratingImpact ?? record.rating_impact)?.eventIds ?? asRecord(record.ratingImpact ?? record.rating_impact)?.event_ids).length,
  };
}

/** `Receipt<T>` has been observed flat and nested under `data`; accept either shape. */
function normalizeCorrectionReceipt(payload: unknown): CorrectionReceipt {
  const top = asRecord(payload);
  const sources = [top, asRecord(top ? top.data : null)];
  const newRevision = field(sources, 'newRevision', 'new_revision');
  return {
    receiptId: nullableString(field(sources, 'receiptId', 'receipt_id')),
    timestamp: nullableString(field(sources, 'timestamp')),
    gameId: nullableString(field(sources, 'gameId', 'game_id')),
    newRevision: newRevision === null ? null : numberValue(newRevision),
    impactDigest: nullableString(field(sources, 'impactDigest', 'impact_digest')),
    appliedAt: nullableString(field(sources, 'appliedAt', 'applied_at', 'createdAt')),
  };
}

/**
 * `GET …/announcements` payload → timeline rows. Shared by the server-rendered page and the
 * projector, which polls the same endpoint from the browser.
 */
export function normalizeAnnouncementsPayload(payload: unknown): Announcement[] {
  const record = asRecord(payload) ?? {};
  const rows = Array.isArray(record.announcements) ? (record.announcements as Record<string, unknown>[]) : [];
  return rows
    .map((row) => {
      const announcementId = value(row, 'id', 'id');
      if (announcementId === null || announcementId === undefined) return null;
      return {
        id: String(announcementId),
        topic: String(value(row, 'topic', 'topic') ?? ''),
        createdAt: nullableString(value(row, 'created_at', 'createdAt')),
        payload: asRecord(value(row, 'payload', 'payload')),
      };
    })
    .filter((row): row is Announcement => row !== null);
}

/**
 * Public announcements timeline for a tournament. `null` means the feed could not be read — the API
 * answers 404 for DRAFT/unknown tournaments, which is reported as `null` too.
 */
export async function listAnnouncements(id: string): Promise<Announcement[] | null> {
  try {
    const response = await fetch(`${API}/api/v2/tournaments/${id}/announcements`, { cache: 'no-store' });
    if (!response.ok) return null;
    return normalizeAnnouncementsPayload(await response.json());
  } catch {
    return null;
  }
}

/** Disputes of a tournament (the API returns every team's disputes ordered newest first). */
export async function fetchDisputes(tournamentId: string): Promise<ApiResult<DisputeRecord[]>> {
  const result = await apiRequest<unknown>(
    `/api/v2/tournaments/${encodeURIComponent(tournamentId)}/disputes`
  );
  if (!result.ok) return { ok: false, status: result.status, data: null, message: result.message };
  return { ok: true, status: result.status, data: normalizeDisputeList(result.data), message: result.message };
}

/** Files a dispute for one of the caller's teams; only valid while RUNNING or PROVISIONAL. */
export async function createDispute(
  tournamentId: string,
  input: { encounterId: string; teamId: string; reason: string }
): Promise<ApiResult<DisputeRecord | null>> {
  const result = await apiRequest<unknown>(
    `/api/v2/tournaments/${encodeURIComponent(tournamentId)}/disputes`,
    { method: 'POST', body: input }
  );
  if (!result.ok) return { ok: false, status: result.status, data: null, message: result.message };
  return { ok: true, status: result.status, data: normalizeDisputeRecord(result.data), message: result.message };
}

/** ADMIN-only decision on a dispute; `note` becomes the `decisions.decision` text. */
export async function resolveDispute(
  disputeId: string,
  decision: 'RESOLVED' | 'REJECTED',
  note: string
): Promise<ApiResult<DisputeRecord | null>> {
  const result = await apiRequest<unknown>(
    `/api/v2/organizer/disputes/${encodeURIComponent(disputeId)}/resolve`,
    { method: 'POST', body: { decision, note } }
  );
  if (!result.ok) return { ok: false, status: result.status, data: null, message: result.message };
  return { ok: true, status: result.status, data: normalizeDisputeRecord(result.data), message: result.message };
}

/** Every game of the bracket with its encounter context; used by the dispute and correction pickers. */
export async function fetchBracketGames(tournamentId: string): Promise<ApiResult<BracketGameOption[]>> {
  const result = await apiRequest<{ encounters?: Record<string, unknown>[] }>(
    `/api/v2/tournaments/${encodeURIComponent(tournamentId)}/bracket`
  );
  if (!result.ok) return { ok: false, status: result.status, data: null, message: result.message };
  const encounters = Array.isArray(result.data?.encounters) ? result.data.encounters : [];
  const games: BracketGameOption[] = [];
  for (const encounter of encounters) {
    const encounterId = String(value(encounter, 'encounter_id', 'encounterId') ?? '');
    const rawGames = Array.isArray(encounter.games) ? encounter.games : [];
    for (const game of rawGames as Record<string, unknown>[]) {
      const gameId = String(value(game, 'id', 'gameId') ?? '');
      if (gameId === '') continue;
      games.push({
        gameId,
        gameOrdinal: numberValue(value(game, 'game_ordinal', 'gameOrdinal')),
        status: String(value(game, 'status', 'status') ?? ''),
        encounterId,
        encounterStatus: String(value(encounter, 'status', 'status') ?? ''),
        stage: String(value(encounter, 'stage', 'stage') ?? 'MAIN'),
        roundOrdinal: numberValue(value(encounter, 'round_ordinal', 'roundOrdinal')),
        slotOrdinal: numberValue(value(encounter, 'slot_ordinal', 'slotOrdinal')),
        teamAId: String(value(encounter, 'team_a_id', 'teamAId') ?? ''),
        teamAName: nullableString(value(encounter, 'team_a_name', 'teamAName')),
        teamBId: nullableString(value(encounter, 'team_b_id', 'teamBId')),
        teamBName: nullableString(value(encounter, 'team_b_name', 'teamBName')),
      });
    }
  }
  return { ok: true, status: result.status, data: games, message: result.message };
}

/**
 * Accepted result of a game — the correction form needs `revision` as `expectedRevision`, and a
 * `404` here means the game has no accepted result to correct yet.
 */
export async function fetchAcceptedResult(gameId: string): Promise<ApiResult<AcceptedResultRef>> {
  const result = await apiRequest<Record<string, unknown>>(
    `/api/v2/games/${encodeURIComponent(gameId)}/result`
  );
  if (!result.ok) return { ok: false, status: result.status, data: null, message: result.message };
  const row = result.data ?? {};
  return {
    ok: true,
    status: result.status,
    data: {
      gameId: String(value(row, 'game_id', 'gameId') ?? gameId),
      revision: numberValue(value(row, 'revision', 'revision')),
      disposition: nullableString(value(row, 'disposition', 'disposition')),
    },
    message: result.message,
  };
}

/** Preview of a correction; the returned `previewDigest` is required by `applyCorrection`. */
export async function previewCorrection(
  gameId: string,
  command: CorrectionCommandInput
): Promise<ApiResult<CorrectionPreview>> {
  const result = await apiRequest<unknown>(
    `/api/v2/organizer/games/${encodeURIComponent(gameId)}/preview-correction`,
    { method: 'POST', body: command }
  );
  if (!result.ok) return { ok: false, status: result.status, data: null, message: result.message };
  return { ok: true, status: result.status, data: normalizeCorrectionPreview(result.data), message: result.message };
}

/** Applies a previewed correction; the API rejects a stale digest with 409 PREVIEW_DIGEST_MISMATCH. */
export async function applyCorrection(
  gameId: string,
  command: CorrectionCommandInput,
  previewDigest: string
): Promise<ApiResult<CorrectionReceipt>> {
  const result = await apiRequest<unknown>(
    `/api/v2/organizer/games/${encodeURIComponent(gameId)}/apply-correction`,
    { method: 'POST', body: { command, previewDigest } }
  );
  // `code` is kept on failure: this action is one the API guards with 403 REAUTH_REQUIRED.
  if (!result.ok) return { ...result, data: null };
  return { ok: true, status: result.status, data: normalizeCorrectionReceipt(result.data), message: result.message };
}

/** Sets the appeal window (minutes) that must elapse before a PROVISIONAL tournament can finalize. */
export interface DisqualificationReceipt {
  readonly tournamentId: string;
  readonly teamId: string;
  readonly stage: string;
  /** Encounters of the team in the stage that were voided. */
  readonly voidedEncounters: number;
  /** Downstream encounters cancelled while the schedule is rebuilt. */
  readonly invalidatedDownstream: number;
  /** True when the call paused a running tournament as part of the ruling. */
  readonly paused: boolean;
  readonly earliestRound: number | null;
}

/** Upheld disqualification: voids a team's stage encounters and rebuilds the schedule. Guarded by re-auth. */
export async function disqualifyTeam(
  tournamentId: string,
  teamId: string,
  command: { readonly reason: string; readonly stage?: string }
): Promise<ApiResult<DisqualificationReceipt>> {
  const result = await apiRequest<DisqualificationReceipt>(
    `/api/v2/organizer/tournaments/${encodeURIComponent(tournamentId)}/teams/${encodeURIComponent(teamId)}/disqualify`,
    { method: 'POST', body: command }
  );
  // `code` is kept on failure: this action is one the API guards with 403 REAUTH_REQUIRED.
  if (!result.ok) return { ...result, data: null };
  return result;
}

export async function setAppealWindow(
  tournamentId: string,
  minutes: number
): Promise<ApiResult<AppealWindowReceipt>> {
  const result = await apiRequest<Record<string, unknown>>(
    `/api/v2/organizer/tournaments/${encodeURIComponent(tournamentId)}/appeal-window`,
    { method: 'POST', body: { minutes } }
  );
  // `code` is kept on failure: this action is one the API guards with 403 REAUTH_REQUIRED.
  if (!result.ok) return { ...result, data: null };
  const row = result.data ?? {};
  return {
    ok: true,
    status: result.status,
    data: {
      tournamentId: String(value(row, 'tournament_id', 'tournamentId') ?? tournamentId),
      finalAppealWindowMinutes: numberValue(value(row, 'final_appeal_window_minutes', 'finalAppealWindowMinutes')),
    },
    message: result.message,
  };
}

/* ---------------------------------------------------------------------------------------------
 * Self-service authentication (ONLINE profile) — registration, mailbox verification and e-mail
 * recovery. Client-side only: `apiRequest` goes through the Next rewrite so the browser session
 * cookie rides along and the API CSRF guard sees `application/json`.
 * ------------------------------------------------------------------------------------------- */

/** Deployment authentication profile from the public, read-only endpoint. */
export type AuthProfile = 'LAN_OFFLINE' | 'ONLINE';
export async function getAuthProfile(options: ServerFetchOptions = {}): Promise<AuthProfile | null> {
  try {
    const url = typeof window === 'undefined' ? `${API}/api/v2/auth/profile` : '/api/v2/auth/profile';
    const response = await fetch(url, { cache: 'no-store', ...(options.cookie ? { headers: { cookie: options.cookie } } : {}) });
    if (!response.ok) return null;
    const payload = (await response.json()) as { authProfile?: unknown };
    return payload.authProfile === 'ONLINE' || payload.authProfile === 'LAN_OFFLINE' ? payload.authProfile : null;
  } catch { return null; }
}
export { getAuthProfile as probeAuthProfile };


/** Identity DTO (`@oantuti/protocol` `UserDto`) as the API serializes it. */
export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: string;
  email: string | null;
  passwordChangeRequired: boolean;
  createdAt: string;
}

/** `GET /api/v2/auth/me` payload: the signed-in identity plus the profile this server runs. */
export interface AuthMe {
  user: AuthUser;
  scope: string;
  teamIds: string[];
  authProfile: AuthProfile;
}

/** `POST /api/v2/auth/register` body. */
export interface RegisterInput {
  username: string;
  displayName: string;
  email: string;
  password: string;
}

/** Registration receipt — the account exists, but its mailbox is not confirmed yet. */
export interface RegisterReceipt {
  user: AuthUser;
  emailVerificationRequired: boolean;
}

/** `users` row → `AuthUser`; `null` when the payload carries no usable identity. */
function toAuthUser(input: unknown): AuthUser | null {
  const row = asRecord(input);
  if (!row) return null;
  const id = String(row.id ?? '');
  if (id === '') return null;
  return {
    id,
    username: String(row.username ?? ''),
    displayName: String(row.displayName ?? row.display_name ?? row.username ?? ''),
    role: String(row.role ?? ''),
    email: nullableString(row.email),
    passwordChangeRequired: row.passwordChangeRequired === true || row.password_change_required === true,
    createdAt: String(row.createdAt ?? row.created_at ?? ''),
  };
}

/** One shared entry code as the organizer list reports it (never the plaintext). */
export interface EntryCodeSummary {
  readonly id: string;
  readonly maxUses: number;
  readonly uses: number;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

/** A freshly created code; the plaintext is returned exactly once. */
export interface CreatedEntryCode {
  readonly code: string;
  readonly maxUses: number;
  readonly expiresAt: string | null;
}


function toEntryCodeSummary(row: Record<string, unknown>): EntryCodeSummary {
  return {
    id: String(row.id ?? ''),
    maxUses: numberValue(value(row, 'max_uses', 'maxUses') ?? 0),
    uses: numberValue(value(row, 'uses', 'uses') ?? 0),
    expiresAt: nullableString(value(row, 'expires_at', 'expiresAt')),
    createdAt: String(row.createdAt ?? row.created_at ?? ''),
  };
}

/** `POST /api/v2/organizer/tournaments/:id/entry-code` (ADMIN, ONLINE only). */
export async function createEntryCode(
  tournamentId: string,
  input: { readonly maxUses?: number; readonly expiresAt?: string | null }
): Promise<ApiResult<CreatedEntryCode>> {
  const result = await apiRequest<Record<string, unknown>>(
    `/api/v2/organizer/tournaments/${encodeURIComponent(tournamentId)}/entry-code`,
    {
      method: 'POST',
      body: {
        ...(input.maxUses !== undefined ? { maxUses: input.maxUses } : {}),
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      },
    }
  );
  if (!result.ok || !result.data) {
    return { ok: false, status: result.status, data: null, message: result.message, code: result.code };
  }
  const code = typeof result.data.code === 'string' ? result.data.code : '';
  if (code === '') {
    return { ok: false, status: result.status, data: null, message: 'Máy chủ không trả về mã vào giải.' };
  }
  return {
    ok: true,
    status: result.status,
    message: result.message,
    code: result.code,
    data: {
      code,
      maxUses: numberValue(result.data.maxUses ?? result.data.max_uses ?? 0),
      expiresAt: nullableString(result.data.expiresAt ?? result.data.expires_at),
    },
  };
}

/** `GET /api/v2/organizer/tournaments/:id/entry-codes` (ADMIN, ONLINE only). */
export async function listEntryCodes(tournamentId: string): Promise<ApiResult<EntryCodeSummary[]>> {
  const result = await apiRequest<{ codes?: unknown }>(
    `/api/v2/organizer/tournaments/${encodeURIComponent(tournamentId)}/entry-codes`
  );
  if (!result.ok) {
    return { ok: false, status: result.status, data: null, message: result.message, code: result.code };
  }
  const rows = Array.isArray(result.data?.codes) ? (result.data?.codes as Record<string, unknown>[]) : [];
  return { ok: true, status: result.status, message: result.message, data: rows.map(toEntryCodeSummary) };
}

/** `POST /api/v2/auth/logout` — ends the current session server-side and clears the cookie. */
export async function logout(): Promise<ApiResult<null>> {
  const result = await apiRequest<unknown>('/api/v2/auth/logout', { method: 'POST', body: {} });
  if (!result.ok) return { ok: false, status: result.status, data: null, message: result.message, code: result.code };
  return { ok: true, status: result.status, data: null, message: result.message, code: result.code };
}

/** `POST /api/v2/tournaments/:id/join` — ONLINE code redemption queues a request for organizer review. */
export async function joinTournamentWithCode(
  tournamentId: string,
  input: { readonly code: string; readonly teamId: string }
): Promise<ApiResult<{ readonly id: string; readonly status: string }>> {
  const result = await apiRequest<Record<string, unknown>>(
    `/api/v2/tournaments/${encodeURIComponent(tournamentId)}/join`,
    { method: 'POST', body: { code: input.code, teamId: input.teamId } }
  );
  if (!result.ok) {
    return { ok: false, status: result.status, data: null, message: result.message, code: result.code };
  }
  const entry = (result.data?.entry ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    status: result.status,
    message: result.message,
    code: result.code,
    data: { id: String(entry.id ?? ''), status: String(entry.status ?? '') },
  };
}

/**
 * `GET /api/v2/auth/me` — the only route that reports the deployment's authentication profile.
 * Answers 401 without a session; a body without `authProfile` is reported as a read failure rather
 * than assumed to be ONLINE.
 */
export async function fetchAuthMe(): Promise<ApiResult<AuthMe>> {
  const result = await apiRequest<Record<string, unknown>>('/api/v2/auth/me');
  if (!result.ok || !result.data) {
    return { ok: false, status: result.status, data: null, message: result.message, code: result.code };
  }
  const user = toAuthUser(result.data.user);
  const reported = result.data.authProfile;
  const profile: AuthProfile | null = reported === 'ONLINE' || reported === 'LAN_OFFLINE' ? reported : null;
  if (!user || profile === null) {
    return {
      ok: false,
      status: result.status,
      data: null,
      message: 'Phản hồi /api/v2/auth/me thiếu thông tin hồ sơ xác thực.',
      code: result.code,
    };
  }
  return {
    ok: true,
    status: result.status,
    message: result.message,
    code: result.code,
    data: {
      user,
      scope: String(result.data.scope ?? ''),
      teamIds: Array.isArray(result.data.teamIds) ? result.data.teamIds.map((teamId) => String(teamId)) : [],
      authProfile: profile,
    },
  };
}

/**
 * `POST /api/v2/auth/register` (ONLINE only). Failures carry a code: 400 `INVALID_USERNAME` /
 * `INVALID_DISPLAY_NAME` / `INVALID_EMAIL` / `WEAK_PASSWORD`, 409 `USERNAME_TAKEN` / `EMAIL_TAKEN`,
 * and 404 `PROFILE_DISABLED` when the deployment runs the LAN_OFFLINE profile.
 */
export async function registerAccount(input: RegisterInput): Promise<ApiResult<RegisterReceipt>> {
  const result = await apiRequest<Record<string, unknown>>('/api/v2/auth/register', {
    method: 'POST',
    body: input,
  });
  const user = toAuthUser(result.data?.user);
  if (!result.ok || !user) {
    return { ok: false, status: result.status, data: null, message: result.message, code: result.code };
  }
  return {
    ok: true,
    status: result.status,
    message: result.message,
    code: result.code,
    data: { user, emailVerificationRequired: result.data?.emailVerificationRequired === true },
  };
}

/**
 * `POST /api/v2/auth/verify-email`. Failures are 400 `EMAIL_VERIFICATION_INVALID` / `_EXPIRED` /
 * `_CONSUMED` (the token lives 24 h) and 404 `PROFILE_DISABLED` under LAN_OFFLINE.
 */
export async function verifyEmailToken(token: string): Promise<ApiResult<{ verified: true }>> {
  const result = await apiRequest<{ verified?: unknown }>('/api/v2/auth/verify-email', {
    method: 'POST',
    body: { token },
  });
  if (!result.ok || result.data?.verified !== true) {
    return {
      ok: false,
      status: result.status,
      data: null,
      message: result.message ?? 'Phản hồi xác minh email không hợp lệ.',
      code: result.code,
    };
  }
  return { ok: true, status: result.status, message: result.message, code: result.code, data: { verified: true } };
}

/**
 * `POST /api/v2/auth/request-password-reset`. The API answers 202 for every address — registered or
 * not — so the caller must render one identical acceptance text either way: no account enumeration.
 * 404 `PROFILE_DISABLED` under LAN_OFFLINE.
 */
export async function requestPasswordReset(email: string): Promise<ApiResult<{ accepted: true }>> {
  const result = await apiRequest<{ accepted?: unknown }>('/api/v2/auth/request-password-reset', {
    method: 'POST',
    body: { email },
  });
  if (!result.ok || result.data?.accepted !== true) {
    return {
      ok: false,
      status: result.status,
      data: null,
      message: result.message ?? 'Phản hồi yêu cầu đặt lại mật khẩu không hợp lệ.',
      code: result.code,
    };
  }
  return { ok: true, status: result.status, message: result.message, code: result.code, data: { accepted: true } };
}

/**
 * `POST /api/v2/auth/reset-password`. Failures are 400 `WEAK_PASSWORD` / `PASSWORD_RESET_INVALID` /
 * `_EXPIRED` / `_CONSUMED` (the token lives 30 minutes) and 404 `PROFILE_DISABLED` under LAN_OFFLINE.
 */
export async function resetPasswordWithToken(
  token: string,
  newPassword: string
): Promise<ApiResult<{ reset: true }>> {
  const result = await apiRequest<{ reset?: unknown }>('/api/v2/auth/reset-password', {
    method: 'POST',
    body: { token, newPassword },
  });
  if (!result.ok || result.data?.reset !== true) {
    return {
      ok: false,
      status: result.status,
      data: null,
      message: result.message ?? 'Phản hồi đặt lại mật khẩu không hợp lệ.',
      code: result.code,
    };
  }
  return { ok: true, status: result.status, message: result.message, code: result.code, data: { reset: true } };
}

/** Requests mailbox verification for a new address; server requires recent reauthentication. */
export async function requestEmailChange(email: string): Promise<ApiResult<{ accepted: true }>> {
  const result = await apiRequest<{ accepted?: unknown }>('/api/v2/auth/change-email', { method: 'POST', body: { email } });
  if (!result.ok || result.data?.accepted !== true) return { ok: false, status: result.status, data: null, message: result.message, code: result.code };
  return { ok: true, status: result.status, data: { accepted: true }, message: result.message, code: result.code };
}

/** Resends the mailbox-confirmation token to an address without disclosing account existence. */
export async function resendEmailVerification(email: string): Promise<ApiResult<{ accepted: true }>> {
  const result = await apiRequest<{ accepted?: unknown }>('/api/v2/auth/resend-verification', { method: 'POST', body: { email } });
  if (!result.ok || result.data?.accepted !== true) return { ok: false, status: result.status, data: null, message: result.message, code: result.code };
  return { ok: true, status: result.status, data: { accepted: true }, message: result.message, code: result.code };
}

/**
 * True when the API refused an ONLINE-only route because the deployment runs the LAN_OFFLINE
 * authentication profile: 404 `{ code: 'PROFILE_DISABLED' }`. Those routes are registered in both
 * profiles and have no other 404, so this code is the evidence an operator can quote.
 */
export function isProfileDisabled(result: ApiResult<unknown>): boolean {
  return result.status === 404 && result.code === 'PROFILE_DISABLED';
}



/* ---------------------------------------------------------------------------------------------
 * Recent re-authentication — the password confirmation the destructive organizer actions require.
 * `POST /api/v2/auth/reauth` is registered in both authentication profiles, so this is not an
 * ONLINE-only surface.
 * ------------------------------------------------------------------------------------------- */

/** `POST /api/v2/auth/reauth` acknowledgement; `null` when the API sent no usable instant. */
export interface ReauthReceipt {
  readonly reauthenticatedUntil: string | null;
}

/**
 * Confirms the signed-in operator's password for the current session. Every guarded organizer action
 * answers 403 `REAUTH_REQUIRED` until this succeeds; the confirmation lasts 10 minutes and covers the
 * one session that made the call. Failures keep their own code: 401 `INVALID_CREDENTIALS` (wrong
 * password), 401 `UNAUTHENTICATED` (no or expired session) and 403 `PASSWORD_CHANGE_REQUIRED` (the
 * session exists only to change the password).
 */
export async function reauth(password: string): Promise<ApiResult<ReauthReceipt>> {
  const result = await apiRequest<{ reauthenticatedUntil?: unknown }>('/api/v2/auth/reauth', {
    method: 'POST',
    body: { password },
  });
  if (!result.ok) return { ...result, data: null };
  const until = result.data?.reauthenticatedUntil;
  return { ...result, data: { reauthenticatedUntil: typeof until === 'string' ? until : null } };
}



export type RatingLoadResult<T> = { readonly kind: 'success'; readonly data: T } | { readonly kind: 'unavailable'; readonly message: string } | { readonly kind: 'notFound' };

async function getRating<T>(path: string, options: ServerFetchOptions): Promise<RatingLoadResult<T>> {
  try {
    const response = await fetch(`${API}${path}`, { cache: 'no-store', headers: options.cookie ? { cookie: options.cookie } : undefined });
    if (response.status === 404) return { kind: 'notFound' };
    if (!response.ok) return { kind: 'unavailable', message: `Không tải được dữ liệu rating (HTTP ${response.status}).` };
    return { kind: 'success', data: await response.json() as T };
  } catch {
    return { kind: 'unavailable', message: 'Không kết nối được API rating.' };
  }
}

export function getGlobalTeamLeaderboard(input: { readonly limit?: number; readonly cursor?: string } = {}, options: ServerFetchOptions = {}): Promise<RatingLoadResult<GlobalLeaderboardDto>> {
  const query = new URLSearchParams({ limit: String(input.limit ?? 50), ...(input.cursor ? { cursor: input.cursor } : {}) });
  return getRating<GlobalLeaderboardDto>(`/api/v2/ratings/teams?${query}`, options);
}

export function getPublicTeamRatingProfile(teamId: string, input: { readonly limit?: number; readonly cursor?: string } = {}, options: ServerFetchOptions = {}): Promise<RatingLoadResult<PublicTeamProfileDto>> {
  const query = new URLSearchParams({ limit: String(input.limit ?? 25), ...(input.cursor ? { cursor: input.cursor } : {}) });
  return getRating<PublicTeamProfileDto>(`/api/v2/ratings/teams/${encodeURIComponent(teamId)}?${query}`, options);
}

export function getTournamentRatingChanges(tournamentId: string, options: ServerFetchOptions = {}): Promise<RatingLoadResult<TournamentRatingChangesDto>> {
  return getRating<TournamentRatingChangesDto>(`/api/v2/tournaments/${encodeURIComponent(tournamentId)}/rating-changes`, options);
}

export function getTournamentTeamRatings(tournamentId: string, options: ServerFetchOptions = {}): Promise<RatingLoadResult<TournamentTeamRatingsDto>> {
  return getRating<TournamentTeamRatingsDto>(`/api/v2/tournaments/${encodeURIComponent(tournamentId)}/team-ratings`, options);
}

export function getRatingReview(tournamentId: string): Promise<ApiResult<RatingReviewDto>> {
  return apiRequest<RatingReviewDto>(`/api/v2/organizer/tournaments/${encodeURIComponent(tournamentId)}/rating-review`);
}

export function setTournamentRated(tournamentId: string, isRated: boolean, expectedVersion: number): Promise<ApiResult<{ tournamentId: string; isRated: boolean; version: number }>> {
  return apiRequest(`/api/v2/organizer/tournaments/${encodeURIComponent(tournamentId)}/rated`, { method: 'POST', body: { isRated, expectedVersion } });
}

export function approveTournamentRating(tournamentId: string, input: { readonly previewDigest: string; readonly generationId: string | null; readonly expectedVersion: number }, idempotencyKey: string): Promise<ApiResult<RatingDecisionReceipt>> {
  return apiRequest(`/api/v2/organizer/tournaments/${encodeURIComponent(tournamentId)}/rating-approve`, { method: 'POST', body: input, headers: { 'idempotency-key': idempotencyKey } });
}

export function rejectTournamentRating(tournamentId: string, input: { readonly reason: string; readonly expectedVersion: number }, idempotencyKey: string): Promise<ApiResult<RatingDecisionReceipt>> {
  return apiRequest(`/api/v2/organizer/tournaments/${encodeURIComponent(tournamentId)}/rating-reject`, { method: 'POST', body: input, headers: { 'idempotency-key': idempotencyKey } });
}

export type OrganizerAccount = UserDto;
export type LanCredential = LanProvisionedUser;
export type OrganizerAuditEvent = {
  readonly id: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly actorUserId: string | null;
  readonly details: unknown;
  readonly createdAt: string;
};
export type InspectedSubmission = {
  readonly id: string;
  readonly receiptOrdinal: number;
  readonly language: BotLanguage;
  readonly entrypoint: string;
  readonly sourceDigest: string;
  readonly status: SubmissionStatus;
  readonly createdAt: string;
};
export type SubmittedSource = PrivateSourceDto;
export type SubmissionBuildLog = {
  readonly submissionId: string;
  readonly status: string;
  readonly buildError: string | null;
  readonly builtAt: string | null;
};

/** Admin account and audit endpoints; source/build-log reads are separately audited by the API. */
export const organizerAccounts = {
  list(): Promise<ApiResult<{ accounts: OrganizerAccount[] }>> {
    return apiRequest('/api/v2/organizer/accounts');
  },
  provision(users: readonly Pick<LanBulkUserEntry, 'username' | 'displayName' | 'role'>[]): Promise<ApiResult<{ created: LanCredential[] }>> {
    return apiRequest('/api/v2/organizer/accounts/provision-lan', { method: 'POST', body: { users } });
  },
  reset(id: string): Promise<ApiResult<LanCredential>> {
    return apiRequest(`/api/v2/organizer/accounts/${encodeURIComponent(id)}/reset-password`, { method: 'POST' });
  },
  revoke(id: string): Promise<ApiResult<{ revoked: number }>> {
    return apiRequest(`/api/v2/organizer/accounts/${encodeURIComponent(id)}/revoke-sessions`, { method: 'POST' });
  },
  audit(resourceId?: string): Promise<ApiResult<{ events: OrganizerAuditEvent[] }>> {
    const query = resourceId ? `?resourceId=${encodeURIComponent(resourceId)}` : '';
    return apiRequest(`/api/v2/organizer/audit-events${query}`);
  },
  submissions(tournamentId: string, teamId: string): Promise<ApiResult<{ submissions: InspectedSubmission[] }>> {
    const query = new URLSearchParams({ teamId });
    return apiRequest(`/api/v2/tournaments/${encodeURIComponent(tournamentId)}/submissions?${query}`);
  },
  source(submissionId: string): Promise<ApiResult<SubmittedSource>> {
    return apiRequest(`/api/v2/submissions/${encodeURIComponent(submissionId)}/source`);
  },
  buildLog(submissionId: string): Promise<ApiResult<SubmissionBuildLog>> {
    return apiRequest(`/api/v2/submissions/${encodeURIComponent(submissionId)}/build-log`);
  },
};
export interface OrganizerTeamOption { readonly id: string; readonly name: string; readonly courseId: string; readonly courseCode: string }
export function searchOrganizerTeams(q: string, input: { readonly limit?: number; readonly offset?: number } = {}): Promise<ApiResult<{ readonly teams: readonly OrganizerTeamOption[]; readonly total: number }>> {
  const query = new URLSearchParams({ q, limit: String(input.limit ?? 50), offset: String(input.offset ?? 0) });
  return apiRequest(`/api/v2/organizer/teams?${query}`);
}
export function addOrganizerTeamMember(teamId: string, userId: string): Promise<ApiResult<TeamDto>> {
  return apiRequest(`/api/v2/organizer/teams/${encodeURIComponent(teamId)}/members`, { method: 'POST', body: { userId } });
}

export interface TeamDto { readonly id: string; readonly name: string; readonly captainUserId: string; readonly tournamentId?: string | null; readonly closedAt?: string | null; readonly rosterLocked?: boolean; readonly members?: readonly { readonly userId: string; readonly username: string; readonly displayName: string; readonly role: string }[] }
export interface TeamInvitationDto { readonly id: string; readonly teamId: string; readonly teamName: string; readonly tournamentId: string; readonly recipientUserId: string; readonly status: 'PENDING'|'ACCEPTED'|'DECLINED'|'REVOKED'; readonly expiresAt: string; readonly createdAt: string }
export const onlineTeams = {
  list(options: ServerFetchOptions = {}): Promise<ApiResult<{ teams: TeamDto[] }>> { return apiRequest(`${API}/api/v2/me/teams`, { headers: options.cookie ? { cookie: options.cookie } : undefined }); },
  create(input: { tournamentId: string; name: string }): Promise<ApiResult<TeamDto>> { return apiRequest('/api/v2/me/teams', { method: 'POST', body: input }); },
  invitations(): Promise<ApiResult<{ invitations: TeamInvitationDto[] }>> { return apiRequest('/api/v2/me/team-invitations'); },
  invite(teamId: string, username: string): Promise<ApiResult<TeamInvitationDto>> { return apiRequest(`/api/v2/teams/${encodeURIComponent(teamId)}/invitations`, { method: 'POST', body: { username } }); },
  respond(id: string, decision: 'ACCEPT'|'DECLINE'): Promise<ApiResult<{ invitation: TeamInvitationDto }>> { return apiRequest(`/api/v2/team-invitations/${encodeURIComponent(id)}/respond`, { method: 'POST', body: { decision } }); },
  revoke(id: string): Promise<ApiResult<{ invitation: TeamInvitationDto }>> { return apiRequest(`/api/v2/team-invitations/${encodeURIComponent(id)}/revoke`, { method: 'POST', body: {} }); },
  remove(teamId: string, userId: string): Promise<ApiResult<TeamDto>> { return apiRequest(`/api/v2/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' }); },
  captain(teamId: string, userId: string): Promise<ApiResult<TeamDto>> { return apiRequest(`/api/v2/teams/${encodeURIComponent(teamId)}/captain`, { method: 'POST', body: { userId } }); },
  leave(teamId: string): Promise<ApiResult<{ left: true }>> { return apiRequest(`/api/v2/teams/${encodeURIComponent(teamId)}/leave`, { method: 'POST', body: {} }); },
  close(teamId: string): Promise<ApiResult<{ closed: true }>> { return apiRequest(`/api/v2/teams/${encodeURIComponent(teamId)}/close`, { method: 'POST', body: {} }); },
  rotateCode(tournamentId: string, codeId: string, input: { maxUses?: number; expiresAt?: string }): Promise<ApiResult<CreatedEntryCode>> { return apiRequest(`/api/v2/organizer/tournaments/${encodeURIComponent(tournamentId)}/entry-codes/${encodeURIComponent(codeId)}/rotate`, { method: 'POST', body: input }); },
  revokeCode(tournamentId: string, codeId: string): Promise<ApiResult<{ id: string; revision: number; revoked: true }>> { return apiRequest(`/api/v2/organizer/tournaments/${encodeURIComponent(tournamentId)}/entry-codes/${encodeURIComponent(codeId)}/revoke`, { method: 'POST', body: {} }); },
};

export type { NewsPostDto, AdminNewsPostDto, StarterBotTemplateDto } from '@oantuti/protocol';

export async function listNews(options: { limit?: number } = {}): Promise<ApiResult<{ posts: NewsPostDto[] }>> {
  const query = options.limit ? `?limit=${options.limit}` : '';
  return apiRequest(`${API}/api/v2/news${query}`);
}

export async function getNewsPost(slug: string): Promise<ApiResult<{ post: NewsPostDto }>> {
  return apiRequest(`${API}/api/v2/news/${encodeURIComponent(slug)}`);
}

export const organizerNews = {
  list(): Promise<ApiResult<{ posts: AdminNewsPostDto[] }>> {
    return apiRequest('/api/v2/organizer/news');
  },
  create(payload: { title: string; slug?: string; summary: string; content: string; publishNow?: boolean }): Promise<ApiResult<{ post: AdminNewsPostDto }>> {
    return apiRequest('/api/v2/organizer/news', { method: 'POST', body: payload });
  },
  update(id: string, payload: { title?: string; summary?: string; content?: string }): Promise<ApiResult<{ post: AdminNewsPostDto }>> {
    return apiRequest(`/api/v2/organizer/news/${encodeURIComponent(id)}`, { method: 'PUT', body: payload });
  },
  publish(id: string): Promise<ApiResult<{ post: AdminNewsPostDto }>> {
    return apiRequest(`/api/v2/organizer/news/${encodeURIComponent(id)}/publish`, { method: 'POST' });
  },
  archive(id: string): Promise<ApiResult<{ post: AdminNewsPostDto }>> {
    return apiRequest(`/api/v2/organizer/news/${encodeURIComponent(id)}/archive`, { method: 'POST' });
  },
};

export async function listStarterBots(): Promise<ApiResult<{ templates: StarterBotTemplateDto[] }>> {
  return apiRequest(`${API}/api/v2/starter-bots`);
}

export function starterBotDownloadUrl(idOrSlug: string): string {
  return `/api/v2/starter-bots/${encodeURIComponent(idOrSlug)}/download`;
}

export const organizerStarterBots = {
  list(): Promise<ApiResult<{ templates: StarterBotTemplateDto[] }>> {
    return apiRequest('/api/v2/organizer/starter-bots');
  },
  create(payload: { name: string; slug?: string; language: BotLanguage; entrypoint: string; description?: string; zipBase64: string }): Promise<ApiResult<{ template: StarterBotTemplateDto }>> {
    return apiRequest('/api/v2/organizer/starter-bots', { method: 'POST', body: payload });
  },
  archive(id: string): Promise<ApiResult<{ archived: boolean }>> {
    return apiRequest(`/api/v2/organizer/starter-bots/${encodeURIComponent(id)}/archive`, { method: 'POST' });
  },
};

