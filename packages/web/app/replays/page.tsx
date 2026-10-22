import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { getOrganizerSession } from '../../lib/api';
import ReplayViewer from './ReplayViewer';

export const metadata: Metadata = { title: 'Xem lại ván đấu — OanTuTi Arena' };

export const dynamic = 'force-dynamic';
export default async function ReplaysPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const store = await cookies();
  const cookie = store.getAll().map((item) => `${item.name}=${item.value}`).join('; ');
  const session = await getOrganizerSession({ cookie });
  if (!session || session.scope === 'PASSWORD_CHANGE_ONLY') redirect('/workspace');
  if (session.role !== 'ADMIN' || session.scope !== 'FULL') notFound();
  const params = await searchParams;
  const rawGame = params.game;
  const rawDigest = params.digest;
  const gameId = (Array.isArray(rawGame) ? rawGame[0] : rawGame) ?? null;
  const digest = (Array.isArray(rawDigest) ? rawDigest[0] : rawDigest) ?? null;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <nav className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
        <Link className="hover:text-[var(--text-primary)]" href="/">
          Giải đấu
        </Link>
        <span>/</span>
        <span className="text-[var(--text-primary)]">Xem lại ván đấu</span>
      </nav>

      <section className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] px-4 py-4">
        <h1 className="text-xl font-semibold">Xem lại ván đấu</h1>
        <p className="mt-2 max-w-3xl text-sm text-[var(--text-secondary)]">
          Replay chính thức dành cho ban tổ chức. Nhập mã ván hoặc digest để xem.
        </p>
        <form action="/replays" method="get" className="mt-4 flex flex-col gap-3 sm:flex-row">
          <input
            type="text"
            name="game"
            defaultValue={gameId ?? ''}
            placeholder="Mã ván (game id)"
            className="min-w-0 flex-1 rounded-md border border-[var(--border-control)] bg-[var(--surface-subtle)] px-3 py-2 text-sm text-[var(--text-primary)]"
          />
          <input
            type="text"
            name="digest"
            defaultValue={digest ?? ''}
            placeholder="hoặc digest replay (hex)"
            className="min-w-0 flex-1 rounded-md border border-[var(--border-control)] bg-[var(--surface-subtle)] px-3 py-2 text-sm text-[var(--text-primary)]"
          />
          <button
            type="submit"
            className="rounded-md bg-[var(--action)] px-5 py-2 text-sm font-semibold text-[var(--action-text)]"
          >
            Xem replay
          </button>
        </form>
      </section>

      {gameId || digest ? (
        <ReplayViewer gameId={gameId} digest={digest} />
      ) : (
        <p className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] px-4 py-8 text-center text-sm text-[var(--text-secondary)]">
          Nhập mã ván hoặc mở replay từ nhánh đấu của giải.
        </p>
      )}
    </div>
  );
}
