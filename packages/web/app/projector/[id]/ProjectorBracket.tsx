'use client';

import type { BracketEncounter, BracketRound } from '../../../lib/api';
import { encounterStatusLabel, stageLabel } from '../../../lib/labels';
import { groupByStageAndRound } from '../../tournaments/[id]/BracketSection';
import { TeamRatingName } from '../../_components/TeamRatingName';

interface ProjectorBracketProps {
  readonly bracket: readonly BracketEncounter[];
  readonly roundMeta: readonly BracketRound[];
  readonly activeGameId: string | null;
  readonly onSelectGame: (gameId: string) => void;
}

export default function ProjectorBracket({
  bracket,
  roundMeta,
  activeGameId,
  onSelectGame,
}: ProjectorBracketProps) {
  const rounds = groupByStageAndRound(bracket as BracketEncounter[]);

  if (bracket.length === 0 || rounds.length === 0) {
    return (
      <div className="p-8 text-center text-[var(--text-secondary)] font-mono text-xs border border-dashed border-[var(--border-subtle)] rounded-xl">
        // CHƯA CÓ NHÁNH ĐẤU NÀO ĐƯỢC XẾP LỊCH CHO GIẢI NÀY
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="border-b border-[var(--border-subtle)] pb-4">
        <h3 className="font-heading text-lg font-bold text-[var(--text-primary)]">
          SƠ ĐỒ NHÁNH ĐẤU (TOURNAMENT BRACKET)
        </h3>
        <p className="mt-1 text-xs text-[var(--text-secondary)] font-mono">
          Nhánh đấu loại trực tiếp hoặc playoff; bấm vào ván đấu của bất kỳ cặp nào để chiếu lên sân khấu chính
        </p>
      </div>

      <div className="flex flex-col gap-6">
        {rounds.map((round) => {
          const meta = roundMeta.find(
            (entry) => entry.stage === round.stage && entry.roundOrdinal === round.roundOrdinal
          );
          const maxSlot = round.encounters.reduce((max, e) => Math.max(max, e.slotOrdinal), 0);
          const slotCount = Math.max(meta?.slotCount ?? 0, maxSlot, round.encounters.length);

          const slots = Array.from(
            { length: slotCount },
            (_, index) => round.encounters.find((e) => e.slotOrdinal === index + 1) ?? null
          );

          return (
            <div key={`${round.stage}-${round.roundOrdinal}`} className="flex flex-col gap-3">
              <div className="flex items-center gap-3 border-b border-[var(--border-subtle)] pb-2 font-mono text-xs">
                <span className="font-heading font-black text-sm text-[var(--accent-secondary)] uppercase">
                  {stageLabel[round.stage] ?? round.stage} · VÒNG {round.roundOrdinal}
                </span>
                <span className="text-[var(--text-secondary)]">({round.encounters.length} cặp đấu)</span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {slots.map((encounter, index) => {
                  if (encounter === null) {
                    return (
                      <article
                        key={`empty-${round.stage}-${round.roundOrdinal}-${index + 1}`}
                        className="rounded-xl border border-dashed border-[var(--border-subtle)] bg-[var(--surface-subtle)] p-4 text-[var(--text-secondary)] font-mono"
                      >
                        <div className="flex items-center justify-between text-xs">
                          <span>Ô #{index + 1}</span>
                          <span className="rounded border border-[var(--border-subtle)] px-2 py-0.5 text-[10px] font-bold">
                            EMPTY
                          </span>
                        </div>
                        <p className="mt-3 text-xs italic">Ô trống — không có cặp đấu</p>
                      </article>
                    );
                  }

                  const teamAWon = encounter.winnerTeamId !== null && encounter.winnerTeamId === encounter.teamAId;
                  const teamBWon = encounter.winnerTeamId !== null && encounter.winnerTeamId === encounter.teamBId;
                  const isLive = encounter.status === 'RUNNING' || encounter.games.some(g => g.status === 'RUNNING');

                  return (
                    <article
                      key={encounter.encounterId}
                      className={`flex flex-col rounded-xl border p-4 shadow-sm transition-all ${
                        isLive
                          ? 'border-[var(--action)] bg-[rgba(255,115,125,0.06)] shadow-[0_0_12px_rgba(255,115,125,0.15)]'
                          : 'border-[var(--border-subtle)] bg-[var(--surface)]'
                      }`}
                    >
                      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] pb-2 text-xs font-mono">
                        <span className="font-semibold text-[var(--text-secondary)]">Ô #{encounter.slotOrdinal}</span>
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ${
                            isLive
                              ? 'border-[var(--action)] bg-[rgba(255,115,125,0.15)] text-[var(--action)] animate-pulse'
                              : 'border-[var(--border-subtle)] text-[var(--text-secondary)]'
                          }`}
                        >
                          {isLive ? '● LIVE' : encounterStatusLabel[encounter.status] ?? encounter.status}
                        </span>
                      </div>

                      <div className="flex flex-col gap-2 py-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className={`text-sm truncate ${teamAWon ? 'font-bold text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>
                            <TeamRatingName teamId={encounter.teamAId} name={encounter.teamAName ?? 'Đội A'} rating={null} />
                          </span>
                          <span className="font-heading text-lg font-black tabular-nums text-[var(--text-primary)]">
                            {encounter.pointsA}
                          </span>
                        </div>

                        <div className="flex items-center justify-between gap-2">
                          <span className={`text-sm truncate ${teamBWon ? 'font-bold text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>
                            {encounter.teamBId ? (
                              <TeamRatingName teamId={encounter.teamBId} name={encounter.teamBName ?? 'Đội B'} rating={null} />
                            ) : (
                              <span className="italic text-[var(--text-secondary)]">Chờ đối thủ</span>
                            )}
                          </span>
                          <span className="font-heading text-lg font-black tabular-nums text-[var(--text-primary)]">
                            {encounter.pointsB}
                          </span>
                        </div>
                      </div>

                      {encounter.games.length > 0 ? (
                        <div className="border-t border-[var(--border-subtle)] pt-2.5 flex flex-wrap items-center gap-1.5 font-mono text-xs">
                          {encounter.games.map((g) => {
                            const isCurrent = g.gameId === activeGameId;
                            return (
                              <button
                                key={g.gameId}
                                type="button"
                                onClick={() => onSelectGame(g.gameId)}
                                className={`px-2 py-0.5 rounded text-[11px] font-medium border transition-all ${
                                  isCurrent
                                    ? 'border-[var(--action)] bg-[var(--action)] text-[var(--action-text)] font-bold'
                                    : 'border-[var(--border-control)] bg-[var(--surface-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                                }`}
                              >
                                Ván {g.gameOrdinal} ▶ Chiếu
                              </button>
                            );
                          })}
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
