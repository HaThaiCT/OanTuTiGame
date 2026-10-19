import FeaturedRanking from './_components/FeaturedRanking';
import { getGlobalTeamLeaderboard, listTournaments } from '../lib/api';
import TournamentCatalog from './_components/TournamentCatalog';

export default async function HomePage() {
  const [tournaments, ratings] = await Promise.all([listTournaments(), getGlobalTeamLeaderboard({ limit: 8 })]);
  return <div>
    <section className="arena-hero">
      <div className="arena-hero-copy"><h1>oantuti-arena: đấu trí thuật toán trong thế giới Búa, Kéo và Giấy</h1></div>
      <FeaturedRanking leaderboard={ratings.kind === 'success' ? ratings.data : null}/>
    </section>
    <TournamentCatalog tournaments={tournaments}/>
  </div>;
}
