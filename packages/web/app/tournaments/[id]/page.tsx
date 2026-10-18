import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getBracket, getMapCommitment, getStandings, getTournament, listAnnouncements } from '../../../lib/api';
import { formatLabel, stateLabel } from '../../../lib/labels';
import AnnouncementsSection from './AnnouncementsSection';
import BracketSection from './BracketSection';
import JoinWithCode from './JoinWithCode';

export default async function TournamentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tournament = await getTournament(id);
  if (!tournament) notFound();
  // The API answers 404 while the tournament has no commitment (including DRAFT); `null` hides the line.
  const [bracket, standings, commitment, announcements] = await Promise.all([
    getBracket(id),
    getStandings(id),
    getMapCommitment(id),
    listAnnouncements(id),
  ]);

  // Extra standings columns are rendered only when the server actually sends the values.
  const showBuchholz = standings.rows.some((row) => row.buchholz !== null && row.buchholz !== undefined);
  const showRatingElo = standings.rows.some((row) => row.ratingElo !== null && row.ratingElo !== undefined);
  const standingsColumns = 6 + (showBuchholz ? 1 : 0) + (showRatingElo ? 1 : 0);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <nav className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
        <Link className="hover:text-[var(--text-primary)]" href="/">Giải đấu</Link>
        <span>/</span>
        <span className="text-[var(--text-primary)]">{tournament.name}</span>
      </nav>

      <JoinWithCode tournamentId={id} state={tournament.state} />

      <header className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">{formatLabel[tournament.format] ?? tournament.format}</p>
            <h1 className="mt-2 break-words text-xl font-semibold md:text-2xl">{tournament.name}</h1>
            <p className="mt-3 text-sm text-[var(--text-secondary)]">Luật {tournament.rulesRevision} · tối đa {tournament.maxTeams} đội</p>
            {commitment ? (
              <p className="mt-2 text-sm text-[var(--text-secondary)]">
                Bản đồ: <span className="font-semibold text-[var(--text-primary)]">{commitment.displayName}</span>{' '}
                · v{commitment.version}
              </p>
            ) : null}
          </div>
          <div className="flex flex-col items-start gap-3">
            <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-3 py-2">
              <p className="text-xs text-[var(--text-secondary)]">Trạng thái</p>
              <p className="mt-1 font-semibold text-[var(--live-accent)]">{stateLabel[tournament.state] ?? tournament.state}</p>
              <p className="mt-0.5 font-mono text-xs text-[var(--text-secondary)]">{tournament.state}</p>
            </div>
            <Link
              className="rounded-md border border-[var(--border-control)] px-4 py-2 text-sm font-semibold hover:border-[var(--action)]"
              href={`/projector/${tournament.id}`}
            >
              Chế độ trình chiếu
            </Link>
          </div>
        </div>
      </header>

      {tournament.state === 'PROVISIONAL' ? (
        <p className="rounded-md border border-[var(--border-subtle)] bg-[var(--warning-tint)] px-4 py-3 text-sm text-[var(--warning-text)]">
          <span className="font-semibold">Kết quả tạm tính (PROVISIONAL)</span> — bảng xếp hạng và nhánh đấu vẫn có thể thay đổi.
          Trong cửa sổ kháng nghị, các đội có thể gửi tranh chấp cho ban tổ chức. Chỉ khi mọi tranh chấp đang mở đã được xử lý,
          giải mới chuyển sang kết quả chính thức.
        </p>
      ) : tournament.state === 'FINALIZED' ? (
        <p className="rounded-md border border-[var(--border-subtle)] bg-[var(--success-tint)] px-4 py-3 text-sm text-[var(--success-text)]">
          <span className="font-semibold">Kết quả chính thức (FINALIZED)</span> — ban tổ chức đã chốt kết quả của giải. Bảng xếp hạng
          và nhánh đấu dưới đây là kết quả cuối cùng; chỉ thay đổi nếu có sửa kết quả ván được ghi nhận ở phần Thông báo.
        </p>
      ) : null}

      <BracketSection encounters={bracket?.encounters ?? null} rounds={bracket?.rounds ?? []} />

      <AnnouncementsSection announcements={announcements} />

      <section className="min-w-0 overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--surface)]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-4 py-3">
          <div>
            <h2 className="text-base font-semibold">Bảng xếp hạng</h2>
            <p className="text-sm text-[var(--text-secondary)]">Stage {standings.stage} · vòng {standings.round || '—'} · thứ hạng do server tính</p>
          </div>
          <span className="rounded-sm border border-[var(--border-subtle)] px-2 py-1 text-xs text-[var(--text-secondary)]">{standings.rows.length} đội</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead className="bg-[var(--surface-subtle)] text-left text-xs uppercase tracking-wide text-[var(--text-secondary)]">
              <tr>
                <th className="px-6 py-3">Hạng</th>
                <th className="px-6 py-3">Đội</th>
                <th className="px-6 py-3 text-center">Đã đấu</th>
                <th className="px-6 py-3 text-center">T–H–B</th>
                <th className="px-6 py-3 text-center">Điểm</th>
                {showBuchholz ? <th className="px-6 py-3 text-center">Buchholz</th> : null}
                {showRatingElo ? <th className="px-6 py-3 text-center">Elo</th> : null}
                <th className="px-6 py-3 text-center">Trạng thái</th>
              </tr>
            </thead>
            <tbody>
              {standings.rows.length === 0 ? (
                <tr>
                  <td colSpan={standingsColumns} className="px-6 py-12 text-center text-[var(--text-secondary)]">
                    Chưa có bảng xếp hạng do server chấp nhận cho vòng này.
                  </td>
                </tr>
              ) : standings.rows.map((row) => (
                <tr
                  key={row.teamId}
                  className={`border-t border-[var(--border-subtle)] ${row.isQualified ? 'bg-[var(--success-tint)]' : ''}`}
                >
                  <td className="px-6 py-4 font-semibold text-[var(--action)]">#{row.rank}</td>
                  <td className="px-6 py-4 font-semibold">{row.teamName}</td>
                  <td className="px-6 py-4 text-center">{row.matchesPlayed}</td>
                  <td className="px-6 py-4 text-center text-[var(--text-secondary)]">{row.wins}–{row.draws}–{row.losses}</td>
                  <td className="px-6 py-4 text-center font-semibold tabular-nums">{row.points}</td>
                  {showBuchholz ? <td className="px-6 py-4 text-center tabular-nums">{row.buchholz ?? '—'}</td> : null}
                  {showRatingElo ? <td className="px-6 py-4 text-center tabular-nums">{row.ratingElo ?? '—'}</td> : null}
                  <td className="px-6 py-4 text-center">
                    {row.isQualified ? (
                      <span className="inline-flex whitespace-nowrap rounded border border-[var(--success-text)] bg-[var(--success-tint)] px-2 py-0.5 text-xs font-semibold text-[var(--success-text)]">
                        Đủ điều kiện
                      </span>
                    ) : (
                      <span className="text-xs text-[var(--text-secondary)]">Đang thi đấu</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
