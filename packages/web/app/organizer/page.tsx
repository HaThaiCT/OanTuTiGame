import { cookies } from 'next/headers';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getAuthProfile, getOrganizerSession, listMaps, listTournaments } from '../../lib/api';
import { formatLabel, stateLabel } from '../../lib/labels';
import OrganizerConsole from './OrganizerConsole';

export const dynamic = 'force-dynamic';

const sections = [
  ['tournaments', 'Giải đấu'], ['create', 'Tạo giải mới'], ['teams', 'Chiến đội'], ['maps', 'Bản đồ'],
] as const;

export default async function OrganizerPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const store = await cookies();
  const cookie = store.getAll().map((item) => `${item.name}=${item.value}`).join('; ');
  const session = await getOrganizerSession({ cookie });
  if (!session || session.scope === 'PASSWORD_CHANGE_ONLY') redirect('/workspace');
  if (session.role !== 'ADMIN' || session.scope !== 'FULL') notFound();
  const query = await searchParams;
  const section = sections.find(([key]) => key === query.tab)?.[0] ?? 'tournaments';
  const tournaments = section === 'tournaments' ? await listTournaments({ cookie }) : [];
  const maps = section === 'maps' ? await listMaps({ cookie }) : [];
  const authProfile = section === 'teams' ? await getAuthProfile({ cookie }) : null;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="border-b border-[var(--border-subtle)] pb-4">
        <h1 className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">
          Ban tổ chức
        </h1>
        <p className="text-xs text-[var(--text-secondary)] mt-1">
          Điều hành giải đấu, xếp lịch thi đấu, quản lý bản đồ và tài khoản
        </p>
      </header>
      <nav aria-label="Quản trị hệ thống" className="flex flex-wrap gap-2">
        {sections.map(([key, label]) => (
          <Link
            key={key}
            href={`/organizer?tab=${key}`}
            aria-current={section === key ? 'page' : undefined}
            className={section === key ? 'vct-btn-primary !py-1.5 !px-4 !text-xs !rounded-full' : 'vct-btn-secondary !py-1.5 !px-4 !text-xs !rounded-full'}
          >
            {label}
          </Link>
        ))}
      </nav>
      {section === 'tournaments' ? (
        <section className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] overflow-hidden shadow-sm">
          <h2 className="border-b border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-5 py-3.5 font-bold text-sm">Giải đấu</h2>
          <ul className="divide-y divide-[var(--border-subtle)]">
            {tournaments.length === 0 ? <li className="p-6 text-sm text-[var(--text-secondary)]">Chưa có giải đấu.</li> : tournaments.map((tournament) => (
              <li key={tournament.id} className="flex flex-wrap items-center justify-between gap-4 px-4 py-4">
                <div><p className="font-semibold">{tournament.name}</p><p className="mt-1 text-sm text-[var(--text-secondary)]">{formatLabel[tournament.format]} · {stateLabel[tournament.state]}</p></div>
                <Link className="text-sm font-semibold text-[var(--action)]" href={`/organizer/tournaments/${encodeURIComponent(tournament.id)}`}>Quản lý giải →</Link>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <OrganizerConsole section={section} tournaments={[]} maps={maps} authProfile={authProfile} accountsScope
          entriesByTournament={{}} commitmentsByTournament={{}} poolsByTournament={{}} />
      )}
    </div>
  );
}
