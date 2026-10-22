import Link from 'next/link';
import { TeamRatingName } from '../../_components/TeamRatingName';
import type { BracketEncounter, BracketRound } from '../../../lib/api';
import { encounterStatusLabel, stageLabel } from '../../../lib/labels';
import BracketGraphic from './BracketGraphic';
import MatchResultPanel from './MatchResultPanel';

export interface BracketSectionProps {
  /** `null` = the bracket API could not be read; `[]` = the server has no encounters scheduled yet. */
  readonly encounters: readonly BracketEncounter[] | null;
  /** Structural width per round; a slot with no encounter row is an EMPTY slot, not a missing match. */
  readonly rounds?: readonly BracketRound[];
  readonly canViewReplay?: boolean;
  readonly format?: string;
}

export interface RoundGroup {
  readonly stage: string;
  readonly roundOrdinal: number;
  readonly encounters: BracketEncounter[];
}

const statusClass: Record<string, string> = {
  PENDING: 'border-[var(--border-subtle)] bg-[var(--surface-subtle)] text-[var(--text-secondary)]',
  RUNNING: 'border-[var(--live-accent)] bg-[rgba(253,186,116,0.15)] text-[var(--live-accent)]',
  COMPLETED: 'border-[var(--info-text)] bg-[var(--info-tint)] text-[var(--info-text)]',
  CANCELLED: 'border-[var(--danger-text)] bg-[var(--danger-tint)] text-[var(--danger-text)]',
  BYE: 'border-[var(--accent-secondary)] text-[var(--accent-secondary)]',
  WALKOVER: 'border-[var(--success-text)] bg-[var(--success-tint)] text-[var(--success-text)]',
  DOUBLE_WITHDRAWAL: 'border-[var(--danger-text)] bg-[var(--danger-tint)] text-[var(--danger-text)]',
};

const unknownStatusClass = 'border-[var(--border-subtle)] bg-[var(--surface-subtle)] text-[var(--text-secondary)]';

/** Groups encounters by `stage::roundOrdinal`, keeping the order the API returned them in. */
export function groupByStageAndRound(encounters: readonly BracketEncounter[]): RoundGroup[] {
  const groups = new Map<string, RoundGroup>();
  for (const encounter of encounters) {
    const key = `${encounter.stage}::${encounter.roundOrdinal}`;
    const existing = groups.get(key);
    if (existing) {
      existing.encounters.push(encounter);
    } else {
      groups.set(key, {
        stage: encounter.stage,
        roundOrdinal: encounter.roundOrdinal,
        encounters: [encounter],
      });
    }
  }
  return [...groups.values()];
}

export default function BracketSection({ encounters, rounds = [], canViewReplay = false, format = '' }: BracketSectionProps) {
  const groups = groupByStageAndRound(encounters ?? []);
  for (const round of rounds) {
    if (!groups.some((group) => group.stage === round.stage && group.roundOrdinal === round.roundOrdinal)) {
      groups.push({ stage: round.stage, roundOrdinal: round.roundOrdinal, encounters: [] });
    }
  }
  const missingGameIds = (encounters ?? []).some(
    (encounter) =>
      (encounter.status === 'COMPLETED' || encounter.status === 'RUNNING') && encounter.games.length === 0
  );

  return (
    <section className="min-w-0 overflow-hidden border border-[var(--border-subtle)] bg-[var(--surface)] rounded-2xl shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-5 py-4">
        <div>
          <h2 className="font-heading text-lg font-bold text-[var(--text-primary)]">
            Sơ đồ nhánh đấu
          </h2>
          <p className="text-xs text-[var(--text-secondary)]">
            Lịch thi đấu và kết quả các cặp đấu
          </p>
        </div>
        <span className="font-mono text-xs text-[var(--text-secondary)] border border-[var(--border-subtle)] px-2.5 py-1 rounded-full">
          {encounters === null ? 'Lỗi dữ liệu' : `${encounters.length} trận`}
        </span>
      </div>
      {encounters ? <BracketGraphic encounters={encounters} rounds={rounds} format={format} /> : null}

      {encounters === null ? (
        <p className="px-6 py-10 text-center text-sm text-[var(--text-secondary)]">
          Không đọc được nhánh đấu từ server — hãy tải lại trang.
        </p>
      ) : encounters.length === 0 && rounds.length === 0 ? (
        <p className="px-6 py-10 text-center text-sm text-[var(--text-secondary)]">
          Chưa có trận nào được xếp lịch. Nhánh đấu chỉ hiện khi server tạo cặp đấu cho vòng đầu.
        </p>
      ) : (
        <div className="flex flex-col divide-y divide-[var(--border-subtle)]">
          {groups.map((group) => (
            <div key={`${group.stage}::${group.roundOrdinal}`} className="px-4 py-4">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold">{stageLabel[group.stage] ?? group.stage}</h3>
                <span className="rounded-sm border border-[var(--border-subtle)] px-2 py-0.5 text-xs text-[var(--text-secondary)]">
                  Vòng {group.roundOrdinal}
                </span>
                {(() => {
                  const meta = rounds.find(
                    (round) => round.stage === group.stage && round.roundOrdinal === group.roundOrdinal
                  );
                  const maxSlot = group.encounters.reduce(
                    (max, encounter) => Math.max(max, encounter.slotOrdinal),
                    0
                  );
                  const slotCount = Math.max(meta?.slotCount ?? 0, maxSlot, group.encounters.length);
                  const emptySlots = slotCount - group.encounters.length;
                  return (
                    <>
                      <span className="text-xs text-[var(--text-secondary)]">{group.encounters.length} trận</span>
                      {emptySlots > 0 ? (
                        <span className="rounded-sm border border-[var(--border-subtle)] px-2 py-0.5 text-xs text-[var(--text-secondary)]">
                          {emptySlots} ô trống (EMPTY)
                        </span>
                      ) : null}
                    </>
                  );
                })()}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] border-collapse text-sm">
                  <thead className="bg-[var(--surface-subtle)] text-left text-xs uppercase tracking-wide text-[var(--text-secondary)]">
                    <tr>
                      <th className="px-4 py-2">Ô</th>
                      <th className="px-4 py-2">Đội A</th>
                      <th className="px-4 py-2 text-center">Tỉ số</th>
                      <th className="px-4 py-2">Đội B</th>
                      <th className="px-4 py-2">Trạng thái</th>
                      <th className="px-4 py-2">Kết quả</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from(
                      {
                        length: (() => {
                          const meta = rounds.find(
                            (round) => round.stage === group.stage && round.roundOrdinal === group.roundOrdinal
                          );
                          const maxSlot = group.encounters.reduce(
                            (max, encounter) => Math.max(max, encounter.slotOrdinal),
                            0
                          );
                          return Math.max(meta?.slotCount ?? 0, maxSlot, group.encounters.length);
                        })(),
                      },
                      (_, index) =>
                        group.encounters.find((encounter) => encounter.slotOrdinal === index + 1) ?? null
                    ).map((encounter, index) => {
                      if (encounter === null) {
                        // Two EMPTY slots: the bracket keeps the position but schedules nothing.
                        return (
                          <tr key={`empty-${group.stage}-${group.roundOrdinal}-${index + 1}`} className="border-t border-dashed border-[var(--border-subtle)]">
                            <td className="px-4 py-3 text-[var(--text-secondary)]">#{index + 1}</td>
                            <td className="px-4 py-3 text-[var(--text-secondary)]" colSpan={2}>
                              Ô trống (EMPTY)
                            </td>
                            <td className="px-4 py-3 text-[var(--text-secondary)]">Không có cặp đấu</td>
                            <td className="px-4 py-3">
                              <span className="inline-flex whitespace-nowrap rounded border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-2 py-0.5 text-xs font-semibold text-[var(--text-secondary)]">
                                EMPTY
                              </span>
                            </td>
                            <td className="px-4 py-3 text-[var(--text-secondary)]">—</td>
                          </tr>
                        );
                      }
                      const scoreA = Number(encounter.pointsA);
                      const scoreB = Number(encounter.pointsB);
                      const teamAWon = encounter.winnerTeamId !== null && encounter.winnerTeamId === encounter.teamAId;
                      const teamBWon = encounter.winnerTeamId !== null && encounter.winnerTeamId === encounter.teamBId;
                      return (
                        <tr key={encounter.encounterId} className="border-t border-[var(--border-subtle)]">
                          <td className="px-4 py-3 text-[var(--text-secondary)]">#{encounter.slotOrdinal}</td>
                          <td className="px-4 py-3">
                            <span className={teamAWon ? 'font-semibold text-[var(--success-text)]' : 'font-medium'}>
                              <TeamRatingName teamId={encounter.teamAId} name={encounter.teamAName ?? 'Đội chưa đặt tên'} rating={null}/>
                            </span>
                            {teamAWon ? (
                              <span className="ml-2 rounded border border-[var(--success-text)] bg-[var(--success-tint)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--success-text)]">
                                Thắng
                              </span>
                            ) : null}
                          </td>
                          <td className="px-4 py-3 text-center tabular-nums">
                            {Number.isFinite(scoreA) ? scoreA : '—'} – {Number.isFinite(scoreB) ? scoreB : '—'}
                          </td>
                          <td className="px-4 py-3">
                            {encounter.teamBId === null ? (
                              <span className="text-[var(--text-secondary)]">{encounter.status === 'BYE' ? 'Bye — miễn đấu' : 'EMPTY — Ô trống'}</span>
                            ) : (
                              <>
                                <span className={teamBWon ? 'font-semibold text-[var(--success-text)]' : 'font-medium'}>
                                  <TeamRatingName teamId={encounter.teamBId} name={encounter.teamBName ?? 'Đội chưa đặt tên'} rating={null}/>
                                </span>
                                {teamBWon ? (
                                  <span className="ml-2 rounded border border-[var(--success-text)] bg-[var(--success-tint)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--success-text)]">
                                    Thắng
                                  </span>
                                ) : null}
                              </>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={`inline-flex whitespace-nowrap rounded border px-2 py-0.5 text-xs font-semibold ${statusClass[encounter.status] ?? unknownStatusClass}`}
                            >
                              {encounterStatusLabel[encounter.status] ?? encounter.status}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            {encounter.games.length > 0 ? (
                              <span className="flex flex-col gap-1 text-xs font-semibold">
                                {encounter.games.map((game) => (
                                  <span key={game.gameId} className="flex flex-wrap items-center gap-3">
                                    <span className="text-[var(--text-secondary)]">Ván {game.gameOrdinal}</span>
                                    {/* Only a running game has a live stream; finished games stay replay-only. */}
                                    {game.status === 'RUNNING' ? (
                                      <Link
                                        className="text-[var(--live-accent)] hover:text-[var(--action-hover)]"
                                        href={`/live/${encodeURIComponent(game.gameId)}`}
                                      >
                                        Trực tiếp
                                      </Link>
                                    ) : null}
                                    <MatchResultPanel gameId={game.gameId} />
                                    {canViewReplay ? <>
                                    <Link
                                      className="text-[var(--action)] hover:text-[var(--action-hover)]"
                                      href={`/replays?game=${encodeURIComponent(game.gameId)}`}
                                    >
                                      Xem replay
                                    </Link>
                                    <Link
                                      className="text-[var(--action)] hover:text-[var(--action-hover)]"
                                      href={`/api/v2/games/${game.gameId}/replay`}
                                    >
                                      Replay tải về
                                    </Link>
                                    </> : null}
                                  </span>
                                ))}
                              </span>
                            ) : encounter.status === 'COMPLETED' || encounter.status === 'RUNNING' ? (
                              <span className="text-xs text-[var(--text-secondary)]">Chưa có mã game</span>
                            ) : (
                              <span className="text-[var(--text-secondary)]">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}

      {missingGameIds ? (
        <p className="border-t border-[var(--border-subtle)] px-6 py-4 text-xs text-[var(--text-secondary)]">
          Một số ván chưa có kết quả để hiển thị.
        </p>
      ) : null}
    </section>
  );
}
