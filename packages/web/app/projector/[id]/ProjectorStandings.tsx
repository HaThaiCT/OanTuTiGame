'use client';

import type { StandingsSnapshot } from '../../../lib/api';
import { TeamRatingName } from '../../_components/TeamRatingName';

interface ProjectorStandingsProps {
  readonly standings: StandingsSnapshot;
}

export default function ProjectorStandings({ standings }: ProjectorStandingsProps) {
  const showBuchholz = standings.rows.some((row) => row.buchholz !== null && row.buchholz !== undefined);
  const showRatingElo = standings.rows.some((row) => row.ratingElo !== null && row.ratingElo !== undefined);

  if (standings.rows.length === 0) {
    return (
      <div className="p-8 text-center text-[var(--text-secondary)] font-mono text-xs border border-dashed border-[var(--border-subtle)] rounded-xl">
        // CHƯA CÓ BẢNG XẾP HẠNG CHO GIẢI NÀY
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] pb-4">
        <div>
          <h3 className="font-heading text-lg font-bold text-[var(--text-primary)]">
            BẢNG XẾP HẠNG GIẢI ĐẤU (LEADERBOARD)
          </h3>
          <p className="mt-1 text-xs text-[var(--text-secondary)] font-mono">
            Bảng xếp hạng tính đến thời điểm hiện tại: {standings.stage} · Vòng {standings.round || '—'}
          </p>
        </div>
        <span className="font-mono text-xs font-semibold px-3 py-1 rounded-full border border-[var(--border-control)] bg-[var(--surface-subtle)] text-[var(--text-primary)]">
          {standings.rows.length} ĐỘI THAM DỰ
        </span>
      </div>

      <div className="overflow-x-auto rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)]">
        <table className="w-full text-left font-mono text-xs">
          <thead className="bg-[var(--surface-subtle)] text-[var(--text-secondary)] uppercase tracking-wider text-[11px] border-b border-[var(--border-subtle)]">
            <tr>
              <th scope="col" className="p-3 w-16">Hạng</th>
              <th scope="col" className="p-3">Chiến đội</th>
              <th scope="col" className="p-3 text-center w-20">Đã đấu</th>
              <th scope="col" className="p-3 text-center w-24">T – H – B</th>
              <th scope="col" className="p-3 text-center w-20">Điểm</th>
              {showBuchholz ? <th scope="col" className="p-3 text-right w-28">Buchholz</th> : null}
              {showRatingElo ? <th scope="col" className="p-3 text-right w-28">Rating Elo</th> : null}
              <th scope="col" className="p-3 text-center w-28">Trạng thái</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border-subtle)]">
            {standings.rows.map((row) => {
              const isTop1 = row.rank === 1;
              const isTop2 = row.rank === 2;
              const isTop3 = row.rank === 3;

              return (
                <tr
                  key={row.teamId}
                  className={`hover:bg-[var(--surface-accent)] transition-colors ${
                    isTop1
                      ? 'bg-[rgba(245,165,36,0.08)]'
                      : isTop2
                        ? 'bg-[rgba(236,232,225,0.05)]'
                        : isTop3
                          ? 'bg-[rgba(251,146,60,0.05)]'
                          : ''
                  }`}
                >
                  <td className="p-3 font-heading font-black text-sm">
                    {isTop1 ? (
                      <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-[#f5a524] text-[#0b1118] font-bold shadow-xs">
                        #1
                      </span>
                    ) : isTop2 ? (
                      <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-[#cbd5e1] text-[#0b1118] font-bold shadow-xs">
                        #2
                      </span>
                    ) : isTop3 ? (
                      <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-[#d97706] text-[#ffffff] font-bold shadow-xs">
                        #3
                      </span>
                    ) : (
                      <span className="text-[var(--text-secondary)] pl-1.5">
                        #{String(row.rank).padStart(2, '0')}
                      </span>
                    )}
                  </td>
                  <td className="p-3">
                    <span className="font-semibold text-sm">
                      <TeamRatingName teamId={row.teamId} name={row.teamName} rating={null} />
                    </span>
                  </td>
                  <td className="p-3 text-center tabular-nums text-[var(--text-primary)]">
                    {row.matchesPlayed}
                  </td>
                  <td className="p-3 text-center tabular-nums text-[var(--text-secondary)]">
                    <span className="text-[var(--success-text)] font-semibold">{row.wins}</span> –{' '}
                    <span>{row.draws}</span> –{' '}
                    <span className="text-[var(--danger-text)] font-semibold">{row.losses}</span>
                  </td>
                  <td className="p-3 text-center font-heading text-base font-black tabular-nums text-[var(--text-primary)]">
                    {row.points}
                  </td>
                  {showBuchholz ? (
                    <td className="p-3 text-right tabular-nums text-[var(--text-secondary)]">
                      {row.buchholz ?? '—'}
                    </td>
                  ) : null}
                  {showRatingElo ? (
                    <td className="p-3 text-right tabular-nums text-[var(--accent-secondary)] font-semibold">
                      {row.ratingElo ?? '—'}
                    </td>
                  ) : null}
                  <td className="p-3 text-center">
                    {row.isQualified ? (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border border-[var(--success-text)] bg-[var(--success-tint)] text-[var(--success-text)]">
                        ✓ Đi tiếp
                      </span>
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
