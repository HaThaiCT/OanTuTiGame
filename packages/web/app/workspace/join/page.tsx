import { cookies } from 'next/headers';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getAuthProfile, getOrganizerSession, listTournaments } from '../../../lib/api';
import JoinWithCode from '../../tournaments/[id]/JoinWithCode';

export const dynamic = 'force-dynamic';

export default async function JoinTournamentPage({ searchParams }: { searchParams: Promise<{ tournament?: string }> }) {
  const store = await cookies();
  const cookie = store.getAll().map((item) => `${item.name}=${item.value}`).join('; ');
  const session = await getOrganizerSession({ cookie });
  if (!session || session.scope === 'PASSWORD_CHANGE_ONLY') redirect('/workspace');
  if (session.role !== 'STUDENT' || session.scope !== 'FULL') notFound();
  const profile = await getAuthProfile({ cookie });
  if (profile !== 'ONLINE') notFound();
  const tournaments = (await listTournaments({ cookie })).filter((item) => item.state === 'REGISTRATION_OPEN');
  const query = await searchParams;
  const selected = tournaments.find((item) => item.id === query.tournament);
  return <section className="flex flex-col gap-5">
    <Link href="/workspace" className="text-sm underline">← Không gian đội</Link>
    <h1 className="text-2xl font-semibold">Tham gia giải bằng mã</h1>
    <form className="flex flex-wrap gap-3">
      <label className="flex flex-col gap-2 text-sm">Chọn giải<select name="tournament" defaultValue={selected?.id ?? ''} required className="rounded-md border border-[var(--border-control)] bg-[var(--surface)] p-3"><option value="" disabled>Chọn giải đang nhận đội</option>{tournaments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <button className="self-end rounded-md border border-[var(--border-control)] px-4 py-3 text-sm">Tiếp tục</button>
    </form>
    {tournaments.length === 0 ? <p className="text-sm text-[var(--text-secondary)]">Chưa có giải đang nhận đội.</p> : null}
    {selected ? <JoinWithCode key={selected.id} tournamentId={selected.id} state={selected.state} /> : null}
  </section>;
}
