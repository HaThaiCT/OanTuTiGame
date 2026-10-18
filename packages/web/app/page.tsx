import FeaturedRanking from './_components/FeaturedRanking';
import { getStandings, listTournaments } from '../lib/api';
import TournamentCatalog from './_components/TournamentCatalog';

export default async function HomePage() {
  const tournaments = await listTournaments();
  const candidates = tournaments.filter(t => t.format !== 'SINGLE_ELIMINATION').slice(0, 8);
  const snapshots = await Promise.all(candidates.map(async tournament => ({ tournament, snapshot: await getStandings(tournament.id) })));
  const rankings = snapshots.filter(entry => entry.snapshot.rows.length > 0).map(({ tournament, snapshot }) => ({ id: tournament.id, name: tournament.name, round: snapshot.round, rows: snapshot.rows }));
  return <div>
    <section className="arena-hero">
      <div className="arena-hero-copy"><h1>oantuti-arena: đấu trí thuật toán trong thế giới Búa, Kéo và Giấy</h1></div>
      <FeaturedRanking rankings={rankings}/>
    </section>
    <TournamentCatalog tournaments={tournaments}/>
  </div>;
}
