import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getBracket, getStandings, getTournament, listAnnouncements } from '../../../lib/api';
import ProjectorBoard from './ProjectorBoard';

/** Venue screens must not be indexed by search engines, and the page is public (no auth). */
export const metadata: Metadata = {
  title: 'Chế độ trình chiếu — OanTuTi Arena',
  robots: { index: false, follow: false },
};

/**
 * LAN projector view of a tournament. The first paint is server-rendered from the public API;
 * `ProjectorBoard` then polls the same endpoints from the browser so the screen stays live.
 */
export default async function ProjectorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tournament = await getTournament(id);
  if (!tournament) notFound();

  const [bracket, standings, announcements] = await Promise.all([
    getBracket(id),
    getStandings(id),
    listAnnouncements(id),
  ]);

  return (
    <ProjectorBoard
      tournamentId={id}
      initialTournament={tournament}
      initialBracket={bracket?.encounters ?? null}
      initialRounds={bracket?.rounds ?? []}
      initialStandings={standings}
      initialAnnouncements={announcements}
    />
  );
}
