import { cookies } from 'next/headers';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getAuthProfile, getOrganizerSession, getTournament, listTournamentEntries, listTournamentRegistrations, onlineTeams, type TeamDto, type TournamentRegistration } from '../../../../../../lib/api';
import { entryStatusLabel, stateLabel } from '../../../../../../lib/labels';
import { registrationErrorText, registrationStatusLabel } from '../../../../../../lib/tournament-registration';
import SubmissionPanel from '../../../../SubmissionPanel';
import PrivateTestPanel from '../../../../PrivateTestPanel';
import DisputePanel from '../../../../DisputePanel';
import TeamOverview from './TeamOverview';
import { TeamRatingName } from '../../../../../_components/TeamRatingName';
import { TournamentRatingProvider } from '../../../../../_components/TournamentRatingContext';
import TournamentRegistrationPanel from '../../../../../tournaments/[id]/TournamentRegistrationPanel';

export const dynamic = 'force-dynamic';

const tabs = [
  { id: 'overview', label: 'Tổng quan' },
  { id: 'submission', label: 'Bài nộp' },
  { id: 'tests', label: 'Test riêng tư' },
  { id: 'appeals', label: 'Kháng nghị' },
] as const;

export default async function TeamTournamentPage({ params, searchParams }: {
  params: Promise<{ id: string; teamId: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const { id, teamId } = await params;
  const store = await cookies();
  const cookie = store.getAll().map((item) => `${item.name}=${item.value}`).join('; ');
  const session = await getOrganizerSession({ cookie });
  if (!session || session.scope === 'PASSWORD_CHANGE_ONLY') redirect('/workspace');
  if (session.scope !== 'FULL' || session.role !== 'STUDENT' || !session.teamIds.includes(teamId)) notFound();
  const [tournament, entries, profile] = await Promise.all([
    getTournament(id),
    listTournamentEntries(id, { cookie }),
    getAuthProfile({ cookie }),
  ]);
  if (!tournament) notFound();
  if (profile === null) return <section role="alert"><h1 className="text-xl font-semibold">Không tải được hồ sơ máy chủ</h1><p className="mt-2">Vui lòng tải lại trang trước khi thao tác với đăng ký.</p><Link href="/workspace" className="mt-3 inline-block underline">Không gian đội</Link></section>;
  if (entries === null) {
    return <section role="alert"><h1 className="text-xl font-semibold">Không tải được thông tin ghi danh</h1><p className="mt-2">Vui lòng tải lại trang hoặc quay lại không gian đội.</p><Link href="/workspace" className="mt-3 inline-block underline">Không gian đội</Link></section>;
  }
  const memberships = entries.filter((entry) => session.teamIds.includes(entry.teamId));
  if (memberships.length > 1) {
    return <section role="alert"><h1 className="text-xl font-semibold">Cần kiểm tra đội tham dự</h1><p className="mt-2">Tài khoản có nhiều đội trong giải này. Vui lòng liên hệ ban tổ chức.</p></section>;
  }
  const entry = memberships.find((item) => item.teamId === teamId) ?? null;
  let team: TeamDto | null = null;
  let registration: TournamentRegistration | null = null;
  if (profile === 'ONLINE') {
    const [teamResult, registrationResult] = await Promise.all([onlineTeams.list({ cookie }), listTournamentRegistrations(id, { cookie })]);
    if (!teamResult.ok || !teamResult.data || !registrationResult.ok || !registrationResult.data) {
      const failed = !teamResult.ok || !teamResult.data ? teamResult : registrationResult;
      return <section role="alert"><h1 className="text-xl font-semibold">Không tải được đăng ký của đội</h1><p className="mt-2">{registrationErrorText(failed)}</p><p className="mt-2">Vui lòng tải lại trang để xem trạng thái hiện tại.</p><Link href="/workspace" className="mt-3 inline-block underline">Không gian đội</Link></section>;
    }
    const ownRegistrations = registrationResult.data.registrations;
    registration = ownRegistrations.find(item => item.teamId === teamId) ?? null;
    team = teamResult.data.teams.find(item => item.id === teamId && (item.tournamentId === id || entry !== null || registration !== null)) ?? null;
  }
  if (!entry && !team && !registration) notFound();
  const canSubmit = entry?.status === 'ELIGIBLE' && (!registration || registration.status === 'APPROVED');
  const visibleTabs = tabs.filter(tab => tab.id === 'overview' || (entry !== null && (tab.id === 'appeals' || canSubmit)));
  const query = await searchParams;
  const active = visibleTabs.find((tab) => tab.id === query.tab)?.id ?? 'overview';
  const base = `/workspace/tournaments/${encodeURIComponent(id)}/teams/${encodeURIComponent(teamId)}`;
  return (
    <div className="flex min-w-0 flex-col gap-5"><TournamentRatingProvider tournamentId={id}>
      <header>
        <Link href="/workspace" className="text-sm text-[var(--text-secondary)] underline">← Không gian đội</Link>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">{tournament.name}</h1>
        <p className="mt-2 text-sm text-[var(--text-secondary)]"><TeamRatingName teamId={teamId} name={team?.name ?? entry?.teamName ?? registration?.teamName ?? ''} rating={null}/> · {stateLabel[tournament.state] ?? tournament.state} · {registration ? registrationStatusLabel[registration.status] : entry ? entryStatusLabel[entry.status] ?? entry.status : 'Chưa gửi đăng ký'}{registration && entry && entry.status !== 'ELIGIBLE' ? ` · ${entryStatusLabel[entry.status] ?? entry.status}` : ''}</p>
        {tournament.registrationClosesAt ? <p className="mt-1 text-sm text-[var(--text-secondary)]">Hạn đăng ký: {tournament.registrationClosesAt.slice(0, 16).replace('T', ' ')} UTC</p> : null}
        <Link href={`/tournaments/${encodeURIComponent(id)}`} className="mt-3 inline-block text-sm text-[var(--action)] underline">Xem trang giải công khai →</Link>
      </header>
      <div id="registration" className="scroll-mt-24"><TournamentRegistrationPanel tournamentId={id} teamId={teamId} state={tournament.state} registrationClosesAt={tournament.registrationClosesAt} /></div>
      {query.tab === 'submission' && !canSubmit ? <p role="status" className="text-sm text-[var(--warning-text)]">Chỉ đội đã được duyệt và đủ điều kiện tham dự mới có quyền nộp bài thi đấu.</p> : null}
      <nav aria-label="Trang đội trong giải" className="flex flex-wrap gap-2 border-b border-[var(--border-subtle)] pb-3">
        {visibleTabs.map((tab) => <Link key={tab.id} prefetch={false} href={`${base}?tab=${tab.id}`} aria-current={active === tab.id ? 'page' : undefined} className={`rounded-md border px-4 py-2 text-sm font-medium ${active === tab.id ? 'border-[var(--action)] bg-[var(--surface)] text-[var(--action)]' : 'border-[var(--border-subtle)]'}`}>{tab.label}</Link>)}
      </nav>
      <section aria-label={tabs.find((tab) => tab.id === active)?.label}>
        {active === 'overview' ? entry ? <TeamOverview tournament={tournament} entry={entry} cookie={cookie} base={base} canSubmit={canSubmit} /> : <section className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-4"><h2 className="font-semibold">Đội chưa được ghi danh thi đấu</h2><p className="mt-2 text-sm text-[var(--text-secondary)]">Theo dõi yêu cầu tại mục Đăng ký tham dự giải ở trên. Khi ADMIN duyệt, tải lại trạng thái để mở bài nộp và các công cụ của đội.</p></section> : null}
        {active === 'submission' && canSubmit ? <SubmissionPanel key={`${id}:${teamId}`} tournamentId={id} teamId={teamId} tournamentState={tournament.state} /> : null}
        {active === 'tests' ? <PrivateTestPanel key={`${id}:${teamId}`} tournamentId={id} teamId={teamId} /> : null}
        {active === 'appeals' ? <DisputePanel key={`${id}:${teamId}`} tournamentId={id} teamId={teamId} tournamentState={tournament.state} /> : null}
      </section>
    </TournamentRatingProvider>
    </div>
  );
}
