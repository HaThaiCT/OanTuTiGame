'use client';

import { useState } from 'react';
import type { BracketEncounter } from '../../../lib/api';
import { encounterStatusLabel, stageLabel } from '../../../lib/labels';
import { TeamRatingName } from '../../_components/TeamRatingName';

interface ProjectorMatchesLiveProps {
  readonly encounters: readonly BracketEncounter[];
  readonly activeGameId: string | null;
  readonly onSelectGame: (gameId: string) => void;
}

type Filter = 'ALL' | 'RUNNING' | 'COMPLETED' | 'PENDING';

export default function ProjectorMatchesLive({
  encounters,
  activeGameId,
  onSelectGame,
}: ProjectorMatchesLiveProps) {
  const [filter, setFilter] = useState<Filter>('ALL');

  const runningCount = encounters.filter(e => e.status === 'RUNNING' || e.games.some(g => g.status === 'RUNNING')).length;
  const completedCount = encounters.filter(e => e.status === 'COMPLETED').length;
  const pendingCount = encounters.filter(e => e.status === 'PENDING').length;

  const filteredEncounters = encounters.filter(e => {
    if (filter === 'ALL') return true;
    if (filter === 'RUNNING') return e.status === 'RUNNING' || e.games.some(g => g.status === 'RUNNING');
    if (filter === 'COMPLETED') return e.status === 'COMPLETED';
    if (filter === 'PENDING') return e.status === 'PENDING';
    return true;
  });

  return (
    <div className="flex flex-col gap-5">
      {/* Header and Filter Controls */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--border-subtle)] pb-4">
        <div>
          <h3 className="font-heading text-lg font-bold text-[var(--text-primary)]">
            BẢNG TRỰC TIẾP & KẾT QUẢ CÁC TRẬN ĐẤU
          </h3>
          <p className="mt-1 text-xs text-[var(--text-secondary)] font-mono">
            Theo dõi diễn biến và kết quả các cặp đấu; bấm "Chiếu ván này" để đưa bàn cờ lên sân khấu chính
          </p>
        </div>

        <div className="flex items-center gap-2 font-mono text-xs">
          <button
            type="button"
            onClick={() => setFilter('ALL')}
            className={`px-3 py-1.5 rounded-lg border font-semibold transition-all ${
              filter === 'ALL'
                ? 'bg-[var(--surface-accent)] border-[var(--action)] text-[var(--text-primary)]'
                : 'border-[var(--border-control)] bg-[var(--surface)] text-[var(--text-secondary)]'
            }`}
          >
            Tất cả ({encounters.length})
          </button>
          <button
            type="button"
            onClick={() => setFilter('RUNNING')}
            className={`px-3 py-1.5 rounded-lg border font-semibold transition-all flex items-center gap-1.5 ${
              filter === 'RUNNING'
                ? 'bg-[rgba(255,115,125,0.15)] border-[var(--action)] text-[var(--action)]'
                : 'border-[var(--border-control)] bg-[var(--surface)] text-[var(--text-secondary)]'
            }`}
          >
            <span className="w-2 h-2 rounded-full bg-[var(--action)] animate-pulse" />
            Đang đấu ({runningCount})
          </button>
          <button
            type="button"
            onClick={() => setFilter('COMPLETED')}
            className={`px-3 py-1.5 rounded-lg border font-semibold transition-all ${
              filter === 'COMPLETED'
                ? 'bg-[rgba(0,245,212,0.12)] border-[var(--accent-secondary)] text-[var(--accent-secondary)]'
                : 'border-[var(--border-control)] bg-[var(--surface)] text-[var(--text-secondary)]'
            }`}
          >
            Đã xong ({completedCount})
          </button>
          <button
            type="button"
            onClick={() => setFilter('PENDING')}
            className={`px-3 py-1.5 rounded-lg border font-semibold transition-all ${
              filter === 'PENDING'
                ? 'bg-[var(--surface-accent)] border-[var(--border-control)] text-[var(--text-primary)]'
                : 'border-[var(--border-control)] bg-[var(--surface)] text-[var(--text-secondary)]'
            }`}
          >
            Chờ đấu ({pendingCount})
          </button>
        </div>
      </div>

      {/* Encounters Grid */}
      {filteredEncounters.length === 0 ? (
        <div className="p-8 text-center text-[var(--text-secondary)] font-mono text-xs border border-dashed border-[var(--border-subtle)] rounded-xl">
          // KHÔNG CÓ TRẬN ĐẤU NÀO PHÙ HỢP VỚI BỘ LỌC HIỆN TẠI
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filteredEncounters.map((encounter) => {
            const isEncounterRunning = encounter.status === 'RUNNING' || encounter.games.some(g => g.status === 'RUNNING');
            const isEncounterDone = encounter.status === 'COMPLETED';
            const teamAWon = encounter.winnerTeamId !== null && encounter.winnerTeamId === encounter.teamAId;
            const teamBWon = encounter.winnerTeamId !== null && encounter.winnerTeamId === encounter.teamBId;

            return (
              <article
                key={encounter.encounterId}
                className={`flex flex-col rounded-xl border p-4 transition-all shadow-sm ${
                  isEncounterRunning
                    ? 'border-[var(--action)] bg-[rgba(255,115,125,0.05)] shadow-[0_0_15px_rgba(255,115,125,0.12)]'
                    : 'border-[var(--border-subtle)] bg-[var(--surface)] hover:border-[var(--border-control)]'
                }`}
              >
                {/* Encounter Card Header */}
                <div className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] pb-2.5 text-xs font-mono">
                  <span className="font-semibold text-[var(--text-secondary)]">
                    {stageLabel[encounter.stage] ?? encounter.stage} · Vòng {encounter.roundOrdinal} · #{encounter.slotOrdinal}
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ${
                      isEncounterRunning
                        ? 'border-[var(--action)] bg-[rgba(255,115,125,0.15)] text-[var(--action)] animate-pulse'
                        : isEncounterDone
                          ? 'border-[var(--accent-secondary)] bg-[rgba(0,245,212,0.1)] text-[var(--accent-secondary)]'
                          : 'border-[var(--border-subtle)] text-[var(--text-secondary)]'
                    }`}
                  >
                    {isEncounterRunning ? '● LIVE' : encounterStatusLabel[encounter.status] ?? encounter.status}
                  </span>
                </div>

                {/* Teams & Scores */}
                <div className="flex flex-col gap-2.5 py-3">
                  {/* Team A */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="w-2.5 h-2.5 rounded-full border border-white bg-[#ece8e1] shrink-0" />
                      <span className={`text-sm truncate ${teamAWon ? 'font-bold text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>
                        <TeamRatingName teamId={encounter.teamAId} name={encounter.teamAName ?? 'Đội A'} rating={null} />
                      </span>
                      {teamAWon ? <span className="text-[10px] font-bold text-[var(--success-text)] font-mono">✓ THẮNG</span> : null}
                    </div>
                    <span className="font-heading text-lg font-black tabular-nums text-[var(--text-primary)]">
                      {encounter.pointsA}
                    </span>
                  </div>

                  {/* Team B */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="w-2.5 h-2.5 rounded-full border border-[#00f5d4] bg-[#101720] shrink-0" />
                      <span className={`text-sm truncate ${teamBWon ? 'font-bold text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>
                        {encounter.teamBId ? (
                          <TeamRatingName teamId={encounter.teamBId} name={encounter.teamBName ?? 'Đội B'} rating={null} />
                        ) : (
                          <span className="text-[var(--text-secondary)] italic">Chờ đối thủ</span>
                        )}
                      </span>
                      {teamBWon ? <span className="text-[10px] font-bold text-[var(--success-text)] font-mono">✓ THẮNG</span> : null}
                    </div>
                    <span className="font-heading text-lg font-black tabular-nums text-[var(--text-primary)]">
                      {encounter.pointsB}
                    </span>
                  </div>
                </div>

                {/* Sub-games list */}
                {encounter.games.length > 0 ? (
                  <div className="border-t border-[var(--border-subtle)] pt-2.5 flex flex-col gap-1.5 font-mono text-xs">
                    <span className="text-[10px] text-[var(--text-secondary)] font-semibold uppercase tracking-wider">
                      CÁC VÁN ĐẤU ({encounter.games.length}):
                    </span>
                    <div className="flex flex-wrap gap-2">
                      {encounter.games.map((g) => {
                        const isCurrent = g.gameId === activeGameId;
                        const isRunning = g.status === 'RUNNING';

                        return (
                          <button
                            key={g.gameId}
                            type="button"
                            onClick={() => onSelectGame(g.gameId)}
                            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs border font-medium transition-all ${
                              isCurrent
                                ? 'border-[var(--action)] bg-[var(--action)] text-[var(--action-text)] font-bold shadow-xs'
                                : isRunning
                                  ? 'border-[var(--live-accent)] bg-[rgba(255,115,125,0.12)] text-[var(--live-accent)]'
                                  : 'border-[var(--border-control)] bg-[var(--surface-subtle)] text-[var(--text-secondary)] hover:border-[var(--action)]'
                            }`}
                            title="Bấm để đưa ván này lên sân đấu trung tâm"
                          >
                            <span>Ván #{g.gameOrdinal}</span>
                            {isRunning ? <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" /> : null}
                            <span className="text-[10px] opacity-80">▶ Chiếu</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
