'use client';

import Link from 'next/link';
import type { GlobalLeaderboardDto } from '@oantuti/protocol';
import { LiveLeaderboard } from './RatingLivePanels';

export default function FeaturedRanking({ leaderboard }: { readonly leaderboard: GlobalLeaderboardDto | null }) {
  return <section className="arena-ranking" aria-label="Xếp hạng đội toàn cục"><div className="arena-ranking-toolbar"><strong>Xếp hạng đội toàn cục</strong></div><LiveLeaderboard initial={leaderboard} featured/><Link href="/rankings">Xem toàn bộ bảng xếp hạng →</Link></section>;
}
