import type { Metadata } from 'next';
import Link from 'next/link';
import LiveViewer from './LiveViewer';

export const metadata: Metadata = { title: 'Trực tiếp — OanTuTi Arena' };

/**
 * Live spectator page of one game. Nothing is fetched on the server: the board only exists once the
 * socket sends its snapshot, and `LiveViewer` opens that socket in a client effect, so the first
 * paint is the deterministic "đang kết nối" state.
 */
export default async function LivePage({ params }: { params: Promise<{ gameId: string }> }) {
  const { gameId } = await params;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <nav className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
        <Link className="hover:text-[var(--text-primary)]" href="/">
          Giải đấu
        </Link>
        <span>/</span>
        <span className="text-[var(--text-primary)]">Trực tiếp</span>
      </nav>

      <LiveViewer gameId={gameId} />
    </div>
  );
}
