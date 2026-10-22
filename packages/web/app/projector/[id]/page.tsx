import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getBracket, getMap, getMapCommitment, getStandings, getTournament, listAnnouncements } from '../../../lib/api';
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

  const [bracket, standings, announcements, commitment] = await Promise.all([
    getBracket(id),
    getStandings(id),
    listAnnouncements(id),
    getMapCommitment(id),
  ]);

  const map = commitment?.slug ? await getMap(commitment.slug) : null;
  return (
    <ProjectorBoard
      tournamentId={id}
      initialTournament={tournament}
      initialBracket={bracket?.encounters ?? null}
      initialRounds={bracket?.rounds ?? []}
      initialStandings={standings}
      initialAnnouncements={announcements}
      initialCommitment={commitment}
      initialMap={map}
    />
  );
}
