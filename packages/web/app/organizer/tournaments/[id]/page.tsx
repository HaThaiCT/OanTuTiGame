import { cookies } from 'next/headers';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getAuthProfile, getMapCommitment, getMapPool, getOrganizerSession, getTournament, listMaps, listTournamentEntries } from '../../../../lib/api';
import OrganizerConsole from '../../OrganizerConsole';

export const dynamic = 'force-dynamic';

const tabs = [
  ['overview', 'Tổng quan'], ['entries', 'Đội tham dự'], ['configuration', 'Bản đồ'],
  ['operations', 'Điều hành'], ['adjudication', 'Kháng nghị / kết quả'],
] as const;

export default async function OrganizerTournamentPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const store = await cookies();
  const cookie = store.getAll().map((item) => `${item.name}=${item.value}`).join('; ');
  const session = await getOrganizerSession({ cookie });
  if (!session || session.scope === 'PASSWORD_CHANGE_ONLY') redirect('/workspace');
  if (session.role !== 'ADMIN' || session.scope !== 'FULL') notFound();
  const { id } = await params;
  const tournament = await getTournament(id);
  if (!tournament) notFound();
  const query = await searchParams;
  const section = tabs.find(([key]) => key === query.tab)?.[0] ?? 'overview';
  const [commitment, pool, maps, entries, authProfile] = await Promise.all([
    getMapCommitment(id, { cookie }),
    section === 'configuration' ? getMapPool(id, { cookie }) : null,
    section === 'configuration' || section === 'operations' ? listMaps({ cookie }) : [],
    tournament.state !== 'DRAFT' && (section === 'entries' || section === 'overview') ? listTournamentEntries(id, { cookie }) : null,
    section === 'entries' ? getAuthProfile({ cookie }) : null,
  ]);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div><Link href="/organizer" className="text-sm text-[var(--text-secondary)]">← Ban tổ chức</Link><h1 className="mt-2 text-2xl font-semibold">{tournament.name}</h1></div>
        {tournament.state !== 'DRAFT' ? <Link href={`/tournaments/${encodeURIComponent(id)}`} className="text-sm text-[var(--action)]">Trang công khai →</Link> : null}
      </header>
      <nav aria-label="Quản lý giải" className="flex flex-wrap gap-2">
        {tabs.map(([key, label]) => (
          <Link key={key} href={`/organizer/tournaments/${encodeURIComponent(id)}?tab=${key}`} aria-current={section === key ? 'page' : undefined}
            className={`rounded-md border px-4 py-2 text-sm ${section === key ? 'border-[var(--action)] text-[var(--action)]' : 'border-[var(--border-subtle)]'}`}>{label}</Link>
        ))}
      </nav>
      <OrganizerConsole key={id} section={section} tournaments={[tournament]} authProfile={authProfile} maps={maps}
        entriesByTournament={{ [id]: entries }} commitmentsByTournament={{ [id]: commitment }} poolsByTournament={{ [id]: pool }} />
    </div>
  );
}
