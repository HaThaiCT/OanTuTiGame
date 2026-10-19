import { getGlobalTeamLeaderboard } from '../../lib/api';
import { LiveLeaderboard } from '../_components/RatingLivePanels';

export const dynamic = 'force-dynamic';

export default async function RankingsPage() {
  const result = await getGlobalTeamLeaderboard({ limit: 50 });
  return <section className="flex flex-col gap-5"><h1 className="text-2xl font-semibold">Xếp hạng đội</h1><p className="text-sm text-[var(--text-secondary)]">Rating global · ArenaContestRating/v1 · 50 đội mỗi trang</p>{result.kind === 'unavailable' && <p role="alert">{result.message}</p>}<LiveLeaderboard initial={result.kind === 'success' ? result.data : null}/></section>;
}
