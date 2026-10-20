import { getGlobalTeamLeaderboard } from '../../lib/api';
import { LiveLeaderboard } from '../_components/RatingLivePanels';

export const dynamic = 'force-dynamic';

export default async function RankingsPage() {
  const result = await getGlobalTeamLeaderboard({ limit: 50 });
  return (
    <section className="flex flex-col gap-6">
      <div className="border-b border-[var(--border-subtle)] pb-4">
        <h1 className="text-2xl font-bold tracking-tight">
          Bảng xếp hạng đội
        </h1>
        <p className="text-xs text-[var(--text-secondary)] mt-1">
          Xếp hạng Rating Global toàn hệ thống · 50 đội mỗi trang
        </p>
      </div>
      {result.kind === 'unavailable' && (
        <div className="p-3 bg-[var(--warning-tint)] border-l-2 border-[var(--warning-text)] text-xs font-mono text-[var(--warning-text)]" role="alert">
          {result.message}
        </div>
      )}
      <LiveLeaderboard initial={result.kind === 'success' ? result.data : null} />
    </section>
  );
}
