'use client';

import Link from 'next/link';
import type { GlobalLeaderboardDto } from '@oantuti/protocol';
import { LiveLeaderboard } from './RatingLivePanels';

export default function FeaturedRanking({ leaderboard }: { readonly leaderboard: GlobalLeaderboardDto | null }) {
  return (
    <section className="arena-ranking" aria-label="Xếp hạng đội toàn cục">
      <div className="arena-ranking-toolbar">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-bold text-[var(--text-primary)]">
            Bảng xếp hạng đội
          </h2>
        </div>
        <span className="font-mono text-[11px] font-semibold px-2 py-0.5 rounded border border-[var(--border-subtle)] bg-[var(--surface)] text-[var(--text-secondary)]">
          Top 8
        </span>
      </div>
      <div className="p-3 sm:p-4 flex flex-col flex-grow justify-between">
        <LiveLeaderboard initial={leaderboard} featured />
        <div className="arena-ranking-footer mt-3 pt-3 border-t border-[var(--border-subtle)]">
          <Link
            href="/rankings"
            className="hover:text-[var(--action)] transition-colors inline-flex items-center gap-1 font-mono text-xs font-semibold text-[var(--text-secondary)]"
          >
            Xem toàn bộ bảng xếp hạng →
          </Link>
        </div>
      </div>
    </section>
  );
}
