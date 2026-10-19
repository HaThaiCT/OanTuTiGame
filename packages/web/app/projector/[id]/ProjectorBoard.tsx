'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  normalizeAnnouncementsPayload,
  normalizeBracketPayload,
  normalizeBracketRounds,
  normalizeStandingsPayload,
  normalizeTournamentRow,
  type Announcement,
  type BracketEncounter,
  type BracketRound,
  type StandingsSnapshot,
  type TournamentSummary,
} from '../../../lib/api';
import {
  announcementTopicLabel,
  encounterStatusLabel,
  formatLabel,
  stageLabel,
  stateLabel,
} from '../../../lib/labels';
import { summarizeAnnouncement } from '../../tournaments/[id]/AnnouncementsSection';
import { groupByStageAndRound } from '../../tournaments/[id]/BracketSection';
import { TeamRatingName } from '../../_components/TeamRatingName';
import { TournamentRatingProvider } from '../../_components/TournamentRatingContext';

/** The public endpoints are the projector's only source; it re-reads them on this cadence. */
const REFRESH_MS = 10_000;

const STATUS_CLASS: Record<string, string> = {
  PENDING: 'border-[var(--border-subtle)] text-[var(--text-secondary)]',
  RUNNING: 'border-[var(--live-accent)] text-[var(--live-accent)]',
  COMPLETED: 'border-[var(--accent-secondary)] text-[var(--accent-secondary)]',
  CANCELLED: 'border-[var(--danger-text)] text-[var(--danger-text)]',
  BYE: 'border-[var(--accent-secondary)] text-[var(--accent-secondary)]',
  WALKOVER: 'border-[var(--success-text)] text-[var(--success-text)]',
  DOUBLE_WITHDRAWAL: 'border-[var(--danger-text)] text-[var(--danger-text)]',
};

const DEFAULT_STATUS_CLASS = 'border-[var(--border-subtle)] text-[var(--text-secondary)]';

/**
 * Read-only LAN projector view: one full-screen page a host can leave open on the venue screen.
 *
 * It renders the same public data as `/tournaments/[id]` (tournament, bracket, standings,
 * announcements) and polls those endpoints every {@link REFRESH_MS}; a failed poll keeps the last
 * good snapshot and says so instead of blanking the screen.
 */
export default function ProjectorBoard({
  tournamentId,
  initialTournament,
  initialBracket,
  initialRounds,
  initialStandings,
  initialAnnouncements,
}: {
  readonly tournamentId: string;
  readonly initialTournament: TournamentSummary;
  readonly initialBracket: BracketEncounter[] | null;
  /** Structural width per round, so EMPTY slots (no encounter row) still appear on the screen. */
  readonly initialRounds: readonly BracketRound[];
  readonly initialStandings: StandingsSnapshot;
  readonly initialAnnouncements: Announcement[] | null;
}) {
  const [tournament, setTournament] = useState(initialTournament);
  const [bracket, setBracket] = useState(initialBracket);
  const [roundMeta, setRoundMeta] = useState<readonly BracketRound[]>(initialRounds);
  const [standings, setStandings] = useState(initialStandings);
  const [announcements, setAnnouncements] = useState(initialAnnouncements);
  // Set only from the polling effect, so server and client always agree on the first render.
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [copied, setCopied] = useState(false);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const base = `/api/v2/tournaments/${encodeURIComponent(tournamentId)}`;

    const read = async (path: string): Promise<Record<string, unknown> | null> => {
      try {
        const response = await fetch(path, { cache: 'no-store' });
        if (!response.ok) return null;
        const payload: unknown = await response.json();
        return payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    };

    const refresh = async () => {
      const [tournamentRow, bracketPayload, standingsPayload, announcementsPayload] = await Promise.all([
        read(base),
        read(`${base}/bracket`),
        read(`${base}/standings`),
        read(`${base}/announcements`),
      ]);
      if (cancelled) return;
      if (tournamentRow) setTournament(normalizeTournamentRow(tournamentRow));
      if (bracketPayload) {
        setBracket(normalizeBracketPayload(bracketPayload));
        setRoundMeta(normalizeBracketRounds(bracketPayload));
      }
      if (standingsPayload) setStandings(normalizeStandingsPayload(standingsPayload));
      if (announcementsPayload) setAnnouncements(normalizeAnnouncementsPayload(announcementsPayload));
      setStale(!tournamentRow && !bracketPayload && !standingsPayload && !announcementsPayload);
      setRefreshedAt(new Date());
    };

    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [tournamentId]);

  const rounds = bracket ? groupByStageAndRound(bracket) : [];
  const showBuchholz = standings.rows.some((row) => row.buchholz !== null && row.buchholz !== undefined);
  const showRatingElo = standings.rows.some((row) => row.ratingElo !== null && row.ratingElo !== undefined);
  const standingsColumns = 6 + (showBuchholz ? 1 : 0) + (showRatingElo ? 1 : 0);
  const statePillClass =
    tournament.state === 'PROVISIONAL'
      ? 'border-[var(--warning-text)] bg-[rgba(253,230,138,0.12)] text-[var(--warning-text)]'
      : tournament.state === 'FINALIZED'
        ? 'border-[var(--success-text)] bg-[rgba(187,247,208,0.12)] text-[var(--success-text)]'
        : 'border-[var(--border-control)] bg-[var(--surface-subtle)] text-[var(--text-primary)]';

  async function toggleFullScreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      // Fullscreen can be refused (permissions/kiosk); leave the page as-is and claim nothing.
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col gap-5 overflow-y-auto bg-[var(--canvas)] p-4 font-mono text-base text-[var(--text-primary)] sm:p-6 xl:p-8"><TournamentRatingProvider tournamentId={tournamentId}>
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--border-subtle)] pb-5">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
            {formatLabel[tournament.format] ?? tournament.format} · chế độ trình chiếu
          </p>
          <h1 className="mt-2 break-words text-2xl font-semibold xl:text-3xl">{tournament.name}</h1>
          <p className="mt-2 text-sm text-[var(--text-secondary)]">
            Luật {tournament.rulesRevision} · tối đa {tournament.maxTeams} đội
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <span className={`rounded-sm border px-3 py-2 text-lg font-semibold ${statePillClass}`}>
            {stateLabel[tournament.state] ?? tournament.state}
          </span>
          <span className="text-xs text-[var(--text-secondary)]">
            Cập nhật lần cuối: {refreshedAt ? refreshedAt.toLocaleTimeString('vi-VN') : '—'} · tự động mỗi 10 giây
          </span>
          {stale ? (
            <span className="text-sm font-semibold text-[var(--danger-text)]">
              Mất kết nối tới server — đang hiển thị dữ liệu cũ.
            </span>
          ) : null}
          <div className="flex flex-wrap gap-2 sm:justify-end">
            <button
              type="button"
              onClick={() => void toggleFullScreen()}
              className="rounded-sm border border-[var(--border-control)] bg-[var(--surface)] px-3 py-2 text-sm font-semibold hover:border-[var(--action)]"
            >
              Toàn màn hình
            </button>
            <button
              type="button"
              onClick={() => void copyLink()}
              className="rounded-sm border border-[var(--border-control)] bg-[var(--surface)] px-3 py-2 text-sm font-semibold hover:border-[var(--action)]"
            >
              {copied ? 'Đã sao chép liên kết' : 'Sao chép liên kết'}
            </button>
          </div>
          <Link className="text-sm text-[var(--action)] hover:text-[var(--action-hover)]" href={`/tournaments/${tournamentId}`}>
            ← Về trang giải đấu
          </Link>
        </div>
      </header>

      {tournament.state === 'PROVISIONAL' ? (
        <p className="rounded-md border border-[var(--border-subtle)] bg-[var(--warning-tint)] px-4 py-3 text-sm font-semibold text-[var(--warning-text)]">
          Kết quả tạm tính (PROVISIONAL) — bảng xếp hạng và nhánh đấu vẫn có thể thay đổi trong cửa sổ kháng nghị.
        </p>
      ) : tournament.state === 'FINALIZED' ? (
        <p className="rounded-md border border-[var(--border-subtle)] bg-[var(--success-tint)] px-4 py-3 text-sm font-semibold text-[var(--success-text)]">
          Kết quả chính thức (FINALIZED) — đây là kết quả cuối cùng của giải.
        </p>
      ) : (
        <p className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--text-secondary)]">
          Giải đang ở trạng thái {stateLabel[tournament.state] ?? tournament.state} — dữ liệu tự cập nhật mỗi 10 giây.
        </p>
      )}

      <section className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] px-4 py-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Thông báo</h2>
        {announcements === null ? (
          <p className="mt-2 text-sm text-[var(--text-secondary)]">Không đọc được thông báo từ server.</p>
        ) : announcements.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--text-secondary)]">Chưa có thông báo nào cho giải này.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {announcements.slice(0, 3).map((announcement) => (
              <li key={announcement.id} className="flex flex-wrap items-baseline gap-x-3">
                <time className="font-mono text-sm text-[var(--text-secondary)]">
                  {announcement.createdAt ? `${announcement.createdAt.slice(0, 16).replace('T', ' ')} UTC` : '—'}
                </time>
                <span className="text-sm font-semibold">
                  {announcementTopicLabel[announcement.topic] ?? announcement.topic}
                </span>
                <span className="text-sm text-[var(--text-secondary)]">
                  {summarizeAnnouncement(announcement.topic, announcement.payload)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex min-w-0 flex-col gap-4">
        <h2 className="text-xl font-semibold">Nhánh đấu</h2>
        {bracket === null ? (
          <p className="text-lg text-[var(--text-secondary)]">Không đọc được nhánh đấu từ server.</p>
        ) : rounds.length === 0 ? (
          <p className="text-lg text-[var(--text-secondary)]">Chưa có trận nào được xếp lịch.</p>
        ) : (
          rounds.map((round) => (
            <div key={`${round.stage}::${round.roundOrdinal}`} className="flex flex-col gap-4">
              <div className="flex flex-wrap items-baseline gap-x-4">
                <h3 className="text-base font-semibold">{stageLabel[round.stage] ?? round.stage}</h3>
                <span className="text-sm text-[var(--text-secondary)]">
                  Vòng {round.roundOrdinal} · {round.encounters.length} trận
                  {(() => {
                    const meta = roundMeta.find(
                      (entry) => entry.stage === round.stage && entry.roundOrdinal === round.roundOrdinal
                    );
                    const maxSlot = round.encounters.reduce(
                      (max, encounter) => Math.max(max, encounter.slotOrdinal),
                      0
                    );
                    const slotCount = Math.max(meta?.slotCount ?? 0, maxSlot, round.encounters.length);
                    const empty = slotCount - round.encounters.length;
                    return empty > 0 ? ` · ${empty} ô trống (EMPTY)` : '';
                  })()}
                </span>
              </div>
              <div className="grid gap-4 xl:grid-cols-2">
                {Array.from(
                  {
                    length: (() => {
                      const meta = roundMeta.find(
                        (entry) => entry.stage === round.stage && entry.roundOrdinal === round.roundOrdinal
                      );
                      const maxSlot = round.encounters.reduce(
                        (max, encounter) => Math.max(max, encounter.slotOrdinal),
                        0
                      );
                      return Math.max(meta?.slotCount ?? 0, maxSlot, round.encounters.length);
                    })(),
                  },
                  (_, index) => round.encounters.find((encounter) => encounter.slotOrdinal === index + 1) ?? null
                ).map((encounter, index) => {
                  if (encounter === null) {
                    return (
                      <article
                        key={`empty-${round.stage}-${round.roundOrdinal}-${index + 1}`}
                        className="rounded-md border border-dashed border-[var(--border-subtle)] px-4 py-4 text-[var(--text-secondary)]"
                      >
                        <div className="flex items-center justify-between gap-4 text-sm">
                          <span>Ô #{index + 1}</span>
                          <span className="rounded border border-[var(--border-subtle)] px-2 py-0.5 font-semibold">
                            EMPTY
                          </span>
                        </div>
                        <p className="mt-3 text-base font-semibold">Ô trống — không có cặp đấu</p>
                      </article>
                    );
                  }
                  const teamAWon = encounter.winnerTeamId !== null && encounter.winnerTeamId === encounter.teamAId;
                  const teamBWon = encounter.winnerTeamId !== null && encounter.winnerTeamId === encounter.teamBId;
                  return (
                    <article
                      key={encounter.encounterId}
                      className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] px-4 py-4"
                    >
                      <div className="flex items-center justify-between gap-4 text-sm text-[var(--text-secondary)]">
                        <span>Ô #{encounter.slotOrdinal}</span>
                        <span
                          className={`rounded border px-2 py-0.5 font-semibold ${STATUS_CLASS[encounter.status] ?? DEFAULT_STATUS_CLASS}`}
                        >
                          {encounterStatusLabel[encounter.status] ?? encounter.status}
                        </span>
                      </div>
                      <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3">
                        <span
                          className={`break-words text-base ${teamAWon ? 'font-semibold text-[var(--success-text)]' : 'font-medium'}`}
                        >
                          <TeamRatingName teamId={encounter.teamAId} name={encounter.teamAName ?? 'Đội chưa đặt tên'} rating={null}/>
                          {teamAWon ? <span className="ml-2 text-xs font-semibold text-[var(--success-text)]">Thắng</span> : null}
                        </span>
                        <span className="text-xl font-semibold tabular-nums">
                          {encounter.pointsA} – {encounter.pointsB}
                        </span>
                        <span
                          className={`break-words text-right text-base ${
                            teamBWon ? 'font-semibold text-[var(--success-text)]' : 'font-medium'
                          }`}
                        >
                          {encounter.teamBId === null ? (
                            <span className="text-[var(--text-secondary)]">Bye — miễn đấu</span>
                          ) : (
                            <>
                              <TeamRatingName teamId={encounter.teamBId} name={encounter.teamBName ?? 'Đội chưa đặt tên'} rating={null}/>
                              {teamBWon ? <span className="ml-2 text-xs font-semibold text-[var(--success-text)]">Thắng</span> : null}
                            </>
                          )}
                        </span>
                      </div>
                      <p className="mt-2 text-start text-sm text-[var(--text-secondary)]">
                        {encounter.games.length > 0
                          ? `${encounter.games.length} ván đã xếp`
                          : encounter.status === 'PENDING'
                            ? 'Chưa có ván nào được xếp'
                            : 'Chưa có mã game từ server'}
                      </p>
                    </article>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </section>

      <section className="flex flex-col gap-3 pb-10">
        <h2 className="text-xl font-semibold">Bảng xếp hạng</h2>
        <p className="text-sm text-[var(--text-secondary)]">
          Stage {standings.stage} · vòng {standings.round || '—'} · thứ hạng do server tính
        </p>
        <div className="overflow-x-auto rounded-md border border-[var(--border-subtle)] bg-[var(--surface)]">
          <table className="w-full min-w-[720px] border-collapse text-base">
            <thead className="bg-[var(--surface-subtle)] text-left text-xs uppercase tracking-wide text-[var(--text-secondary)]">
              <tr>
                <th className="px-5 py-3">Hạng</th>
                <th className="px-5 py-3">Đội</th>
                <th className="px-5 py-3 text-center">Đã đấu</th>
                <th className="px-5 py-3 text-center">T–H–B</th>
                <th className="px-5 py-3 text-center">Điểm</th>
                {showBuchholz ? <th className="px-5 py-3 text-center">Buchholz</th> : null}
                {showRatingElo ? <th className="px-5 py-3 text-center">Elo trong giải</th> : null}
                <th className="px-5 py-3 text-center">Trạng thái</th>
              </tr>
            </thead>
            <tbody>
              {standings.rows.length === 0 ? (
                <tr>
                  <td colSpan={standingsColumns} className="px-5 py-10 text-center text-[var(--text-secondary)]">
                    Chưa có bảng xếp hạng do server chấp nhận cho vòng này.
                  </td>
                </tr>
              ) : (
                standings.rows.map((row) => (
                  <tr
                    key={row.teamId}
                    className={`border-t border-[var(--border-subtle)] ${row.isQualified ? 'bg-[var(--success-tint)]' : ''}`}
                  >
                    <td className="px-5 py-4 text-lg font-semibold text-[var(--action)]">#{row.rank}</td>
                    <td className="px-5 py-4 text-base font-semibold"><TeamRatingName teamId={row.teamId} name={row.teamName} rating={null}/></td>
                    <td className="px-5 py-4 text-center tabular-nums">{row.matchesPlayed}</td>
                    <td className="px-5 py-4 text-center tabular-nums text-[var(--text-secondary)]">
                      {row.wins}–{row.draws}–{row.losses}
                    </td>
                    <td className="px-5 py-4 text-center text-lg font-semibold tabular-nums">{row.points}</td>
                    {showBuchholz ? (
                      <td className="px-5 py-4 text-center tabular-nums">{row.buchholz ?? '—'}</td>
                    ) : null}
                    {showRatingElo ? (
                      <td className="px-5 py-4 text-center tabular-nums">{row.ratingElo ?? '—'}</td>
                    ) : null}
                    <td className="px-5 py-4 text-center">
                      {row.isQualified ? (
                        <span className="whitespace-nowrap rounded-sm border border-[var(--success-text)] px-2 py-0.5 text-xs font-semibold text-[var(--success-text)]">
                          Đủ điều kiện
                        </span>
                      ) : (
                        <span className="text-xs text-[var(--text-secondary)]">Đang thi đấu</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </TournamentRatingProvider>
    </div>
  );
}
