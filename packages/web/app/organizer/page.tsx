import { cookies } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  getAuthProfile,
  getMapCommitment,
  getMapPool,
  getOrganizerSession,
  listMaps,
  listTournamentEntries,
  listTournaments,
  type MapCommitment,
  type MapPoolView,
  type TournamentEntry,
} from '../../lib/api';
import { formatLabel, stateLabel } from '../../lib/labels';
import OrganizerConsole from './OrganizerConsole';

export const dynamic = 'force-dynamic';

async function sessionCookieHeader(): Promise<string | undefined> {
  const store = await cookies();
  const values = store.getAll();
  if (values.length === 0) return undefined;
  return values.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

export default async function OrganizerPage() {
  const cookie = await sessionCookieHeader();
  const session = await getOrganizerSession({ cookie });
  // A session that still owes its first password change may only change it or sign out; the console
  // would render but every action would answer 403 PASSWORD_CHANGE_REQUIRED. Send it to the surface
  // that completes the change.
  if (session?.scope === 'PASSWORD_CHANGE_ONLY') redirect('/workspace');
  const isAdmin = session?.role === 'ADMIN';
  const tournaments = await listTournaments(isAdmin ? { cookie } : {});
  const maps = isAdmin ? await listMaps({ cookie }) : [];
  // ONLINE-only controls (shared entry codes) need the deployment profile, read once on the server.
  const authProfile = isAdmin ? await getAuthProfile({ cookie }) : null;

  const entriesByTournament: Record<string, TournamentEntry[] | null> = {};
  const commitmentsByTournament: Record<string, MapCommitment | null> = {};
  const poolsByTournament: Record<string, MapPoolView | null> = {};
  if (isAdmin) {
    await Promise.all(
      tournaments.map(async (tournament) => {
        // The map pool and the commitment are exactly what a DRAFT tournament is edited for, so they
        // are read for every tournament; the entry list is not served for DRAFT (the API answers 404).
        const [commitment, pool] = await Promise.all([
          getMapCommitment(tournament.id, { cookie }),
          getMapPool(tournament.id, { cookie }),
        ]);
        commitmentsByTournament[tournament.id] = commitment;
        poolsByTournament[tournament.id] = pool;
        if (tournament.state !== 'DRAFT') {
          entriesByTournament[tournament.id] = await listTournamentEntries(tournament.id, { cookie });
        }
      })
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Ban tổ chức</h1>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">
          Tạo giải, công bố, mở đăng ký, khóa danh sách và điều khiển vòng đấu. Mọi thao tác đều được server ghi audit.
        </p>
      </header>

      {isAdmin ? (
        <OrganizerConsole
          tournaments={tournaments}
          entriesByTournament={entriesByTournament}
          commitmentsByTournament={commitmentsByTournament}
          maps={maps}
          authProfile={authProfile}
          poolsByTournament={poolsByTournament}
    />
      ) : (
        <>
          <section className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-4 sm:p-5">
            <h2 className="text-base font-semibold">Cần quyền ADMIN</h2>
            <p className="mt-2 text-sm text-[var(--text-secondary)]">
              {session
                ? `Tài khoản ${session.displayName || session.username} có vai trò ${session.role}, không đủ quyền ban tổ chức.`
                : 'Bạn chưa đăng nhập.'}{' '}
              Hãy đăng nhập bằng tài khoản ADMIN để tạo giải và điều khiển vòng đấu.
            </p>
            <Link
              href="/workspace"
              className="mt-4 inline-block rounded-md bg-[var(--action)] px-5 py-3 text-sm font-semibold text-[#0B0D17]"
            >
              Đăng nhập tại không gian đội →
            </Link>
          </section>

          <section className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface)]">
            <div className="border-b border-[var(--border-subtle)] px-4 py-3">
              <h2 className="text-base font-semibold">Giải đấu công khai</h2>
              <p className="mt-1 text-sm text-[var(--text-secondary)]">Giải ở trạng thái bản nháp chỉ hiển thị với tài khoản ADMIN.</p>
            </div>
            <ul className="divide-y divide-[var(--border-subtle)]">
              {tournaments.length === 0 ? (
                <li className="px-6 py-10 text-center text-[var(--text-secondary)]">Chưa có giải nào trong database.</li>
              ) : (
                tournaments.map((tournament) => (
                  <li key={tournament.id} className="flex flex-wrap items-center justify-between gap-4 px-6 py-4">
                    <div>
                      <p className="font-semibold">{tournament.name}</p>
                      <p className="mt-1 text-sm text-[var(--text-secondary)]">
                        {formatLabel[tournament.format] ?? tournament.format} · {stateLabel[tournament.state] ?? tournament.state}
                      </p>
                    </div>
                    <span className="rounded-full border border-[var(--border-subtle)] px-3 py-1 text-xs text-[var(--text-secondary)]">
                      {tournament.maxTeams} đội tối đa
                    </span>
                  </li>
                ))
              )}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
