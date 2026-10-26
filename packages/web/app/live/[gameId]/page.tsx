import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { getOrganizerSession } from '../../../lib/api';
import LiveViewer from './LiveViewer';

export const metadata: Metadata = { title: 'Trực tiếp — OanTuTi Arena' };
export const dynamic = 'force-dynamic';

/**
 * Public live board; the server session only controls the official replay entry point.
 */
export default async function LivePage({ params }: { params: Promise<{ gameId: string }> }) {
  const { gameId } = await params;
  const store = await cookies();
  const cookie = store.getAll().map((item) => `${item.name}=${item.value}`).join('; ');
  const session = await getOrganizerSession({ cookie });

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <nav className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
        <Link className="hover:text-[var(--text-primary)]" href="/tournaments">
          Giải đấu
        </Link>
        <span>/</span>
        <span className="text-[var(--text-primary)]">Trực tiếp</span>
      </nav>

      <LiveViewer gameId={gameId} canViewReplay={session?.role === 'ADMIN' && session.scope === 'FULL'} />
    </div>
  );
}
