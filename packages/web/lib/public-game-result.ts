
export interface PublicGameResult {
  readonly gameId: string;
  readonly winner: number;
  readonly reason: string;
  readonly disposition: string;
  readonly totalTurns: number;
  readonly revision: number | null;
  readonly acceptedAt: string | null;
}

/** Normalize only fields in the public result summary; privileged evidence digests are discarded. */
export function normalizePublicGameResult(payload: unknown): PublicGameResult | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const row = payload as Record<string, unknown>;
  const gameId = row.gameId ?? row.game_id;
  const winnerValue = row.winner;
  const totalTurnsValue = row.totalTurns ?? row.total_turns;
  const winner = typeof winnerValue === 'number' || (typeof winnerValue === 'string' && winnerValue.trim() !== '') ? Number(winnerValue) : Number.NaN;
  const totalTurns = typeof totalTurnsValue === 'number' || (typeof totalTurnsValue === 'string' && totalTurnsValue.trim() !== '') ? Number(totalTurnsValue) : Number.NaN;
  const revisionRaw = row.revision;
  const revision = revisionRaw === null || revisionRaw === undefined ? null : Number(revisionRaw);
  const reason = row.reason;
  const disposition = row.disposition;
  const validDispositions = ['DECISIVE', 'DRAW', 'NO_CONTEST'];
  if (typeof gameId !== 'string' || gameId === '' || !Number.isInteger(winner) || ![0, 1, 2].includes(winner)
    || !Number.isFinite(totalTurns) || totalTurns < 0 || !Number.isInteger(totalTurns)
    || typeof reason !== 'string' || reason === '' || typeof disposition !== 'string' || !validDispositions.includes(disposition)
    || (revision !== null && (!Number.isInteger(revision) || revision < 1))) return null;
  if ((disposition === 'DECISIVE' && ![1, 2].includes(winner)) || (disposition === 'DRAW' && winner !== 0)
    || (disposition === 'NO_CONTEST' && winner !== 0)) return null;
  return {
    gameId,
    winner,
    reason,
    disposition,
    totalTurns,
    revision,
    acceptedAt: typeof (row.acceptedAt ?? row.accepted_at) === 'string' ? String(row.acceptedAt ?? row.accepted_at) : null,
  } satisfies PublicGameResult;
}



export function describePublicGameResult(result: PublicGameResult): { readonly winner: string; readonly reason: string; readonly disposition: string } {
  const reasonLabels: Record<string, string> = {
    EXTINCTION: 'Diệt hết quân đối phương',
    THRONE_BREACH: 'Chiếm ngai đối phương',
    STALEMATE: 'Đối phương hết nước đi',
    TIMEOUT: 'Đối phương hết thời gian',
    BOT_TIMEOUT: 'Bot không phản hồi trong thời gian cho phép',
    ILLEGAL_MOVE: 'Đối phương đi sai luật',
    CRASH_FORFEIT: 'Bot đối phương gặp lỗi',
    MAX_TURNS_MATERIAL: 'Hết lượt tối đa — so sánh số quân còn lại',
    MAX_TURNS_PROXIMITY: 'Hết lượt tối đa — so sánh khoảng cách tới ngai',
    MAX_TURNS_DRAW: 'Hòa — hết số lượt tối đa',
    INVALID_START_BOTH_SIDES: 'Không tính kết quả — thế cờ đầu không hợp lệ cho cả hai bên',
    PROTOCOL_VIOLATION: 'Đối phương vi phạm giao thức',
    WIN_REASON_UNSPECIFIED: 'Không xác định lý do',
  };
  const dispositions: Record<string, string> = { DECISIVE: 'Phân thắng bại', DRAW: 'Hòa', NO_CONTEST: 'Không tính kết quả' };
  const winner = result.disposition === 'NO_CONTEST'
    ? 'Không tính kết quả'
    : result.winner === 1 ? 'Quân Trắng thắng'
      : result.winner === 2 ? 'Quân Đen thắng'
        : 'Hòa';
  return {
    winner,
    reason: reasonLabels[result.reason] ?? 'Lý do chưa được mô tả',
    disposition: dispositions[result.disposition] ?? 'Chưa xác định',
  };
}
export type TournamentDirectoryStatus = 'ALL' | 'LIVE' | 'UPCOMING' | 'ENDED';

const statesByDirectoryStatus: Record<Exclude<TournamentDirectoryStatus, 'ALL'>, readonly string[]> = {
  LIVE: ['RUNNING', 'PAUSED', 'PROVISIONAL'],
  UPCOMING: ['PUBLISHED', 'REGISTRATION_OPEN', 'VALIDATING_SUBMISSIONS', 'LOCKED', 'READY_TO_START'],
  ENDED: ['FINALIZED', 'ARCHIVED', 'CANCELLED'],
};

export function filterTournaments<T extends { readonly name: string; readonly state: string; readonly format: string }>(
  tournaments: readonly T[],
  filters: { readonly status: TournamentDirectoryStatus; readonly format: string; readonly query: string },
): T[] {
  const query = filters.query.trim().toLocaleLowerCase('vi');
  return tournaments.filter((tournament) => {
    if (tournament.state === 'DRAFT') return false;
    if (filters.status !== 'ALL' && !statesByDirectoryStatus[filters.status].includes(tournament.state)) return false;
    if (filters.format !== 'ALL' && tournament.format !== filters.format) return false;
    return !query || tournament.name.toLocaleLowerCase('vi').includes(query);
  });
}

const directoryPriority: Readonly<Record<string, number>> = {
  REGISTRATION_OPEN: 0,
  RUNNING: 1,
  PAUSED: 1,
  PROVISIONAL: 1,
  PUBLISHED: 2,
  VALIDATING_SUBMISSIONS: 2,
  LOCKED: 2,
  READY_TO_START: 2,
  FINALIZED: 3,
  ARCHIVED: 4,
  CANCELLED: 4,
};

/** Put events accepting entrants and then live events ahead of completed history; preserve API order within each group. */
export function orderTournamentsForDirectory<T extends { readonly state: string }>(tournaments: readonly T[]): T[] {
  return tournaments
    .map((tournament, index) => ({ tournament, index }))
    .sort((left, right) => (directoryPriority[left.tournament.state] ?? 5) - (directoryPriority[right.tournament.state] ?? 5) || left.index - right.index)
    .map(({ tournament }) => tournament);
}
