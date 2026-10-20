'use client';

import Link from 'next/link';
import type { GlobalLeaderboardDto } from '@oantuti/protocol';
import { LiveLeaderboard } from './RatingLivePanels';

export default function FeaturedRanking({ leaderboard }: { readonly leaderboard: GlobalLeaderboardDto | null }) {
  return (
    <section className="arena-ranking" aria-label="Xếp hạng đội toàn cục">
      <div className="arena-ranking-toolbar">
        <div className="flex items-center gap-2">
          <strong className="text-sm font-bold">
            Bảng xếp hạng đội
          </strong>
        </div>
        <span className="font-mono text-xs text-[var(--accent-secondary)] font-semibold">Top 8</span>
      </div>
      <div className="p-4 flex flex-col flex-grow justify-between">
        <LiveLeaderboard initial={leaderboard} featured />
        <div className="arena-ranking-footer mt-4">
          <Link
            href="/rankings"
            className="hover:text-[var(--action)] transition-colors inline-flex items-center gap-1 font-heading text-xs uppercase tracking-wider"
          >
            Xem toàn bộ xếp hạng →
          </Link>
        </div>
      </div>
    </section>
  );
}
