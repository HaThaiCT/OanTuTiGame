import Link from 'next/link';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { getBracket, getMapCommitment, getOrganizerSession, getStandings, getTournament, getTournamentTeamRatings, listAnnouncements, listTournamentEntries } from '../../../lib/api';
import { formatLabel, stateLabel } from '../../../lib/labels';
import AnnouncementsSection from './AnnouncementsSection';
import BracketSection from './BracketSection';
import { TeamRatingName } from '../../_components/TeamRatingName';
import { TournamentRatingProvider } from '../../_components/TournamentRatingContext';
import RatingStatus from './RatingStatus';

export const dynamic = 'force-dynamic';
export default async function TournamentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tournament = await getTournament(id);
  if (!tournament) notFound();
  const store = await cookies();
  const cookie = store.getAll().map(item => `${item.name}=${item.value}`).join('; ');
  const session = await getOrganizerSession({ cookie });
  const isAdmin = session?.role === 'ADMIN' && session.scope === 'FULL';
  const ownEntries = session?.role === 'STUDENT' && session.scope === 'FULL' ? (await listTournamentEntries(id, { cookie }))?.filter(entry => session.teamIds.includes(entry.teamId)) ?? [] : [];
  const [bracket, standings, commitment, announcements, teamRatings] = await Promise.all([getBracket(id), getStandings(id), getMapCommitment(id), listAnnouncements(id), getTournamentTeamRatings(id)]);
  const ratingsByTeam = teamRatings.kind === 'success' ? new Map(teamRatings.data.teams.map(team => [team.teamId, team.rating])) : new Map();
  const showBuchholz = standings.rows.some(row => row.buchholz !== null && row.buchholz !== undefined);
  const showRatingElo = standings.rows.some(row => row.ratingElo !== null && row.ratingElo !== undefined);
  const standingsColumns = 6 + (showBuchholz ? 1 : 0) + (showRatingElo ? 1 : 0);
  return (
    <TournamentRatingProvider tournamentId={id} initial={teamRatings.kind === 'success' ? teamRatings.data : null}>
      <div className="flex min-w-0 flex-col gap-6">
        <nav className="flex min-w-0 flex-wrap items-center gap-2 font-mono text-xs text-[var(--text-secondary)] uppercase">
          <Link href="/" className="hover:text-[var(--action)]">TRANG CHỦ</Link>
          <span>/</span>
          <span className="text-[var(--text-primary)]">{tournament.name}</span>
        </nav>

        <div className="flex flex-wrap items-center justify-between gap-4">
          {isAdmin ? (
            <Link className="vct-btn-primary !py-2 !px-4 !text-xs !rounded-full" href={`/organizer/tournaments/${encodeURIComponent(id)}`}>
              Quản lý giải đấu →
            </Link>
          ) : ownEntries.length === 1 ? (
            <Link className="vct-btn-primary !py-2 !px-4 !text-xs !rounded-full" href={`/workspace/tournaments/${encodeURIComponent(id)}/teams/${encodeURIComponent(ownEntries[0].teamId)}`}>
              Vào trang đội của tôi →
            </Link>
          ) : ownEntries.length > 1 ? (
            <p className="text-xs text-[var(--warning-text)] bg-[var(--warning-tint)] p-2 rounded-xl border border-[var(--warning-text)]">
              Tài khoản thuộc nhiều đội trong giải. Liên hệ ban tổ chức để kiểm tra.
            </p>
          ) : null}
          <Link
            className="vct-btn-secondary !py-2 !px-4 !text-xs !rounded-full ml-auto"
            href={`/projector/${tournament.id}`}
          >
            Chế độ trình chiếu →
          </Link>
        </div>

        <header className="border border-[var(--border-subtle)] bg-[var(--surface)] p-6 sm:p-7 rounded-2xl shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-6">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-2">
                <span className="font-semibold text-xs text-[var(--accent-secondary)]">
                  {formatLabel[tournament.format] ?? tournament.format}
                </span>
              </div>
              <h1 className="break-words text-2xl font-bold tracking-tight md:text-3xl text-[var(--text-primary)]">
                {tournament.name}
              </h1>
              <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-[var(--text-secondary)]">
                <span>
                  Luật: <strong className="text-[var(--text-primary)] font-medium">{tournament.rulesRevision}</strong>
                </span>
                <span>·</span>
                <span>
                  Tối đa: <strong className="text-[var(--text-primary)] font-medium">{tournament.maxTeams} đội</strong>
                </span>
                {commitment && (
                  <>
                    <span>·</span>
                    <span>
                      Bản đồ: <strong className="text-[var(--text-primary)] font-medium">{commitment.displayName} (v{commitment.version})</strong>
                    </span>
                  </>
                )}
              </div>
            </div>
            <div className="flex flex-col items-start gap-3">
              <div className="border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-4 py-2.5 rounded-xl w-full">
                <p className="font-mono text-[10px] text-[var(--text-secondary)] uppercase tracking-wider">TRẠNG THÁI</p>
                <p className="mt-1 font-mono font-bold text-sm text-[var(--live-accent)] uppercase">
                  ● {stateLabel[tournament.state] ?? tournament.state}
                </p>
              </div>
              <span className={`font-mono text-[10px] font-bold tracking-widest px-3 py-1 rounded-full uppercase shadow-xs ${tournament.isRated ? 'bg-[var(--action)] text-white' : 'border border-[var(--border-subtle)] bg-[var(--surface-subtle)] text-[var(--text-secondary)]'}`}>
                {tournament.isRated ? 'RATED' : 'UNRATED'}
              </span>
            </div>
          </div>
        </header>

        {tournament.state === 'PROVISIONAL' ? (
          <div className="border border-[var(--warning-text)] bg-[var(--warning-tint)] px-4 py-3 rounded-xl text-xs text-[var(--warning-text)] shadow-xs">
            <span className="font-semibold">Kết quả tạm tính:</span> Bảng xếp hạng và nhánh đấu có thể thay đổi sau khi xử lý kháng nghị.
          </div>
        ) : tournament.state === 'FINALIZED' ? (
          <div className="border border-[var(--success-text)] bg-[var(--success-tint)] px-4 py-3 rounded-xl text-xs text-[var(--success-text)] shadow-xs">
            <span className="font-semibold">Kết quả chính thức:</span> Mọi điều chỉnh sau khi chốt sẽ được ghi nhận trong Thông báo.
          </div>
        ) : null}

        <BracketSection encounters={bracket?.encounters ?? null} rounds={bracket?.rounds ?? []} canViewReplay={isAdmin} format={tournament.format} />
        <RatingStatus tournamentId={id} isRated={tournament.isRated} />
        <AnnouncementsSection announcements={announcements} />

        <section className="min-w-0 overflow-hidden border border-[var(--border-subtle)] bg-[var(--surface)] rounded-2xl shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-5 py-4">
            <div>
              <h2 className="font-heading text-lg font-bold text-[var(--text-primary)]">
                Bảng xếp hạng
              </h2>
              <p className="text-xs text-[var(--text-secondary)]">
                Stage {standings.stage} · Vòng {standings.round || '—'}
              </p>
            </div>
            <span className="font-mono text-xs text-[var(--text-secondary)] border border-[var(--border-subtle)] px-2.5 py-1 rounded-full">
              {standings.rows.length} ĐỘI
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-sm">
              <thead className="bg-[var(--surface-subtle)] text-left font-heading text-xs uppercase tracking-wider text-[var(--text-secondary)] border-b border-[var(--border-subtle)]">
                <tr>
                  <th className="px-5 py-3 w-16">HẠNG</th>
                  <th className="px-5 py-3">CHIẾN ĐỘI</th>
                  <th className="px-5 py-3 text-center">ĐÃ ĐẤU</th>
                  <th className="px-5 py-3 text-center">T–H–B</th>
                  <th className="px-5 py-3 text-center">ĐIỂM</th>
                  {showBuchholz && <th className="px-5 py-3 text-center">BUCHHOLZ</th>}
                  {showRatingElo && <th className="px-5 py-3 text-center">ELO TRONG GIẢI</th>}
                  <th className="px-5 py-3 text-center">TRẠNG THÁI</th>
                </tr>
              </thead>
              <tbody>
                {standings.rows.length === 0 ? (
                  <tr>
                    <td colSpan={standingsColumns} className="px-6 py-12 text-center font-mono text-xs text-[var(--text-secondary)]">
                      // CHƯA CÓ BẢNG XẾP HẠNG ĐƯỢC CHẤP NHẬN CHO VÒNG NÀY.
                    </td>
                  </tr>
                ) : (
                  standings.rows.map(row => (
                    <tr
                      key={row.teamId}
                      className={`border-t border-[var(--border-subtle)] hover:bg-[var(--surface-subtle)] transition-colors ${
                        row.isQualified ? 'bg-[rgba(0,245,212,0.04)]' : ''
                      }`}
                    >
                      <td className="px-5 py-3.5 font-mono font-bold text-[var(--action)]">
                        #{String(row.rank).padStart(2, '0')}
                      </td>
                      <td className="px-5 py-3.5 font-medium">
                        <TeamRatingName teamId={row.teamId} name={row.teamName} rating={ratingsByTeam.get(row.teamId) ?? null} />
                      </td>
                      <td className="px-5 py-3.5 text-center font-mono">{row.matchesPlayed}</td>
                      <td className="px-5 py-3.5 text-center font-mono text-[var(--text-secondary)]">
                        {row.wins}–{row.draws}–{row.losses}
                      </td>
                      <td className="px-5 py-3.5 text-center font-mono font-bold text-[var(--text-primary)]">
                        {row.points}
                      </td>
                      {showBuchholz && (
                        <td className="px-5 py-3.5 text-center font-mono text-[var(--text-secondary)]">
                          {row.buchholz ?? '—'}
                        </td>
                      )}
                      {showRatingElo && (
                        <td className="px-5 py-3.5 text-center font-mono text-[var(--text-secondary)]">
                          {row.ratingElo ?? '—'}
                        </td>
                      )}
                      <td className="px-5 py-3.5 text-center">
                        {row.isQualified ? (
                          <span className="font-mono text-[10px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full border border-[var(--success-text)] bg-[var(--success-tint)] text-[var(--success-text)]">
                            ĐỦ ĐIỀU KIỆN
                          </span>
                        ) : (
                          <span className="font-mono text-[11px] text-[var(--text-secondary)] uppercase">
                            ĐANG ĐẤU
                          </span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </TournamentRatingProvider>
  );
}
