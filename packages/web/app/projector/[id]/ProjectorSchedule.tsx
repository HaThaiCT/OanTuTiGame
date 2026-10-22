'use client';

import type { BracketEncounter } from '../../../lib/api';
import { encounterStatusLabel, stageLabel } from '../../../lib/labels';
import { TeamRatingName } from '../../_components/TeamRatingName';

interface ProjectorScheduleProps {
  readonly encounters: readonly BracketEncounter[];
  readonly activeGameId: string | null;
  readonly onSelectGame: (gameId: string) => void;
}

export default function ProjectorSchedule({
  encounters,
  activeGameId,
  onSelectGame,
}: ProjectorScheduleProps) {
  if (encounters.length === 0) {
    return (
      <div className="p-8 text-center text-[var(--text-secondary)] font-mono text-xs border border-dashed border-[var(--border-subtle)] rounded-xl">
        // CHƯA CÓ LỊCH THI ĐẤU NÀO ĐƯỢC XẾP CHO GIẢI NÀY
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="border-b border-[var(--border-subtle)] pb-4">
        <h3 className="font-heading text-lg font-bold text-[var(--text-primary)]">
          LỊCH THI ĐẤU CHI TIẾT (FIXTURES & SCHEDULE)
        </h3>
        <p className="mt-1 text-xs text-[var(--text-secondary)] font-mono">
          Danh sách lịch trình toàn bộ các cặp đấu theo vòng; bấm nút chiếu tại ván bất kỳ để xem diễn biến
        </p>
      </div>

      <div className="overflow-x-auto rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)]">
        <table className="w-full text-left font-mono text-xs">
          <thead className="bg-[var(--surface-subtle)] text-[var(--text-secondary)] uppercase tracking-wider text-[11px] border-b border-[var(--border-subtle)]">
            <tr>
              <th scope="col" className="p-3 w-28">Giai đoạn</th>
              <th scope="col" className="p-3 w-16">Vòng</th>
              <th scope="col" className="p-3 w-16">Ô #</th>
              <th scope="col" className="p-3">Đội Trắng (A)</th>
              <th scope="col" className="p-3 text-center w-24">Tỉ số</th>
              <th scope="col" className="p-3">Đội Đen (B)</th>
              <th scope="col" className="p-3 w-32">Trạng thái</th>
              <th scope="col" className="p-3">Ván đấu</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border-subtle)]">
            {encounters.map((encounter) => {
              const isRunning = encounter.status === 'RUNNING' || encounter.games.some(g => g.status === 'RUNNING');
              const teamAWon = encounter.winnerTeamId !== null && encounter.winnerTeamId === encounter.teamAId;
              const teamBWon = encounter.winnerTeamId !== null && encounter.winnerTeamId === encounter.teamBId;

              return (
                <tr
                  key={encounter.encounterId}
                  className={`hover:bg-[var(--surface-accent)] transition-colors ${
                    isRunning ? 'bg-[rgba(255,115,125,0.06)]' : ''
                  }`}
                >
                  <td className="p-3 font-semibold text-[var(--text-primary)]">
                    {stageLabel[encounter.stage] ?? encounter.stage}
                  </td>
                  <td className="p-3 tabular-nums">Vòng {encounter.roundOrdinal}</td>
                  <td className="p-3 tabular-nums">#{encounter.slotOrdinal}</td>
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full border border-white bg-[#ece8e1] shrink-0" />
                      <span className={teamAWon ? 'font-bold text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}>
                        <TeamRatingName teamId={encounter.teamAId} name={encounter.teamAName ?? 'Đội A'} rating={null} />
                      </span>
                    </div>
                  </td>
                  <td className="p-3 text-center font-heading text-sm font-black tabular-nums text-[var(--text-primary)]">
                    {encounter.pointsA} : {encounter.pointsB}
                  </td>
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full border border-[#00f5d4] bg-[#101720] shrink-0" />
                      <span className={teamBWon ? 'font-bold text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}>
                        {encounter.teamBId ? (
                          <TeamRatingName teamId={encounter.teamBId} name={encounter.teamBName ?? 'Đội B'} rating={null} />
                        ) : (
                          <span className="italic text-[var(--text-secondary)]">Chờ đối thủ</span>
                        )}
                      </span>
                    </div>
                  </td>
                  <td className="p-3">
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ${
                        isRunning
                          ? 'border-[var(--action)] bg-[rgba(255,115,125,0.15)] text-[var(--action)] animate-pulse'
                          : encounter.status === 'COMPLETED'
                            ? 'border-[var(--accent-secondary)] text-[var(--accent-secondary)]'
                            : 'border-[var(--border-subtle)] text-[var(--text-secondary)]'
                      }`}
                    >
                      {isRunning ? '● LIVE' : encounterStatusLabel[encounter.status] ?? encounter.status}
                    </span>
                  </td>
                  <td className="p-3">
                    {encounter.games.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
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
                              Ván #{g.gameOrdinal} ▶
                            </button>
                          );
                        })}
                      </div>
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
  );
}
