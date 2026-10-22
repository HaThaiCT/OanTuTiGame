import Link from 'next/link';
import { getBracket, getStandings, listAnnouncements, type TournamentEntry, type TournamentSummary } from '../../../../../../lib/api';
import { submissionStatusLabel } from '../../../../../../lib/labels';
import AnnouncementsSection from '../../../../../tournaments/[id]/AnnouncementsSection';
import { TeamRatingName } from '../../../../../_components/TeamRatingName';

export default async function TeamOverview({ tournament, entry, cookie, base, canSubmit }: {
  tournament: TournamentSummary;
  entry: TournamentEntry;
  cookie: string;
  base: string;
  canSubmit: boolean;
}) {
  const [bracket, standings, announcements, candidateResponse] = await Promise.all([
    getBracket(tournament.id),
    getStandings(tournament.id),
    listAnnouncements(tournament.id),
    fetch(`${process.env.API_BASE ?? 'http://127.0.0.1:4301'}/api/v2/tournaments/${encodeURIComponent(tournament.id)}/entries/me?teamId=${encodeURIComponent(entry.teamId)}`, { cache: 'no-store', headers: { cookie } }).catch(() => null),
  ]);
  const candidatePayload = candidateResponse?.ok ? await candidateResponse.json() as { candidate?: { status?: string; receiptOrdinal?: number; receipt_ordinal?: number } | null } : null;
  const candidate = candidatePayload?.candidate;
  const own = bracket?.encounters.filter((match) => match.teamAId === entry.teamId || match.teamBId === entry.teamId) ?? [];
  const next = own.find((match) => !['COMPLETED', 'FINALIZED', 'CANCELLED', 'BYE'].includes(match.status) && !match.winnerTeamId);
  const recent = own.filter((match) => match.status === 'COMPLETED' || match.winnerTeamId !== null).slice(-3).reverse();
  const standing = standings.rows.find((row) => row.teamId === entry.teamId);
  const intakeOpen = tournament.state === 'REGISTRATION_OPEN' || tournament.state === 'VALIDATING_SUBMISSIONS';
  const frozen = ['LOCKED', 'READY_TO_START', 'RUNNING', 'PAUSED', 'PROVISIONAL', 'FINALIZED', 'ARCHIVED'].includes(tournament.state);
  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-4">
        <h2 className="font-semibold">Bài nộp của đội</h2>
        <p className="mt-2 text-sm">{candidatePayload === null ? canSubmit ? 'Chưa tải được trạng thái bài nộp. Mở Bài nộp để thử lại.' : 'Không tải được trạng thái bài nộp hiện tại; lịch sử được giữ trên máy chủ.' : candidate ? `Bài #${candidate.receiptOrdinal ?? candidate.receipt_ordinal ?? '—'} · ${submissionStatusLabel[candidate.status ?? ''] ?? candidate.status ?? 'Đã nhận'}` : 'Chưa có bài sẵn sàng thi đấu.'}</p>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">{!canSubmit ? 'Đội chưa có đăng ký được duyệt hoặc không còn đủ điều kiện tham dự. Lịch sử bài nộp được giữ; không thể nộp bài thi đấu mới.' : intakeOpen ? 'Nộp bản mới trước khi giải khóa bài.' : frozen ? entry.status === 'ELIGIBLE' ? 'Bài thi đấu đã được chốt theo danh sách của ban tổ chức. Test riêng tư vẫn dùng được.' : 'Đợt nhận bài đã đóng. Xem trạng thái tham dự của đội; test riêng tư vẫn dùng được.' : 'Đợt nhận bài chưa mở. Bạn vẫn có thể xem lịch sử và chạy test riêng tư.'}</p>
        <div className="mt-3 flex flex-wrap gap-4 text-sm text-[var(--action)]">{canSubmit ? <><Link href={`${base}?tab=submission`} className="underline">{intakeOpen ? 'Chuẩn bị bài nộp →' : 'Xem bài nộp →'}</Link><Link href={`${base}?tab=tests`} className="underline">Chạy test riêng tư →</Link></> : null}</div>
      </section>
      <section className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-4">
        <h2 className="font-semibold">Thi đấu và kết quả</h2>
        {standing ? <p className="mt-2 text-sm">Hạng {standing.rank} · {standing.points} điểm · {standing.wins} thắng / {standing.draws} hòa / {standing.losses} thua</p> : <p className="mt-2 text-sm text-[var(--text-secondary)]">Chưa có điểm xếp hạng cho đội.</p>}
        {bracket === null ? <p className="mt-2 text-sm text-[var(--warning-text)]">Không tải được lịch thi đấu.</p> : next ? <p className="mt-2 text-sm">Vòng {next.roundOrdinal}: gặp {next.teamAId === entry.teamId ? next.teamBId ? <TeamRatingName teamId={next.teamBId} name={next.teamBName ?? 'Đội B'} rating={null}/> : 'đối thủ chờ xác định' : <TeamRatingName teamId={next.teamAId} name={next.teamAName ?? 'Đội A'} rating={null}/>} · {next.status === 'RUNNING' ? 'Đang đấu' : 'Chờ thi đấu'}</p> : <p className="mt-2 text-sm text-[var(--text-secondary)]">Chưa có trận tiếp theo được xếp lịch.</p>}
        {recent.length > 0 ? <ul className="mt-3 space-y-2 text-sm">{recent.map((match) => <li key={match.encounterId}>Vòng {match.roundOrdinal} · <TeamRatingName teamId={match.teamAId} name={match.teamAName ?? 'Đội A'} rating={null}/> {match.pointsA} – {match.pointsB} {match.teamBId ? <TeamRatingName teamId={match.teamBId} name={match.teamBName ?? 'Đội B'} rating={null}/> : 'Miễn đấu'}</li>)}</ul> : null}
        <Link href={`${base}?tab=appeals`} className="mt-3 inline-block text-sm text-[var(--action)] underline">Xem và gửi kháng nghị →</Link>
      </section>
      <AnnouncementsSection announcements={announcements?.slice(0, 5) ?? null} />
    </div>
  );
}
