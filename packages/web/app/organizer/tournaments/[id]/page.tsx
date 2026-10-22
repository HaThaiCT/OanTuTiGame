import { cookies } from 'next/headers';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getAuthProfile, getMapCommitment, getMapPool, getOrganizerSession, getTournament, listMaps, listTournamentEntries } from '../../../../lib/api';
import OrganizerConsole from '../../OrganizerConsole';

export const dynamic = 'force-dynamic';


export default async function OrganizerTournamentPage({ params }: {
  params: Promise<{ id: string }>;
}) {
  const store = await cookies();
  const cookie = store.getAll().map((item) => `${item.name}=${item.value}`).join('; ');
  const session = await getOrganizerSession({ cookie });
  if (!session || session.scope === 'PASSWORD_CHANGE_ONLY') redirect('/workspace');
  if (session.role !== 'ADMIN' || session.scope !== 'FULL') notFound();
  const { id } = await params;
  const tournament = await getTournament(id);
  if (!tournament) notFound();
  const [commitment, pool, maps, entries, authProfile] = await Promise.all([
    getMapCommitment(id, { cookie }),
    getMapPool(id, { cookie }),
    listMaps({ cookie }),
    tournament.state !== 'DRAFT' ? listTournamentEntries(id, { cookie }) : null,
    getAuthProfile({ cookie }),
  ]);
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] pb-4">
        <div>
          <Link href="/organizer" className="text-xs font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
            ← Ban tổ chức
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">{tournament.name}</h1>
            <span className="rounded-full border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-2.5 py-0.5 text-xs font-mono font-semibold text-[var(--action)]">
              {tournament.format}
            </span>
          </div>
        </div>
        {tournament.state !== 'DRAFT' ? (
          <Link
            href={`/tournaments/${encodeURIComponent(id)}`}
            className="vct-btn-secondary !text-xs !py-1.5 !px-3 font-semibold text-[var(--action)]"
          >
            Trang công khai giải →
          </Link>
        ) : null}
      </header>
      <OrganizerConsole
        key={id}
        section="tournament"
        tournaments={[tournament]}
        authProfile={authProfile}
        maps={maps}
        entriesByTournament={{ [id]: entries }}
        commitmentsByTournament={{ [id]: commitment }}
        poolsByTournament={{ [id]: pool }}
      />
    </div>
  );
}
