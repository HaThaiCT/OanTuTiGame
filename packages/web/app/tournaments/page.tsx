import type { Metadata } from 'next';
import Link from 'next/link';
import { listTournaments } from '../../lib/api';
import { formatLabel, stateLabel } from '../../lib/labels';
import TournamentCatalog from '../_components/TournamentCatalog';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Giải đấu — OanTuTi Arena',
  description: 'Danh sách các giải đấu bot thuật toán OanTuTi: lịch thi đấu, thể thức, nhánh đấu và kết quả.',
};

export default async function TournamentsPage() {
  const tournaments = await listTournaments();
  const running = tournaments.filter(t => t.state === 'RUNNING');
  const spotlight = running[0] ?? tournaments[0] ?? null;

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div className="border-b border-[var(--border-subtle)] pb-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-[var(--text-primary)]">
              Giải đấu OanTuTi
            </h1>
            <p className="mt-1.5 text-sm text-[var(--text-secondary)]">
              Theo dõi diễn biến các giải đấu thuật toán, xem nhánh đấu và lịch thi đấu trực tiếp.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Link href="/workspace" className="vct-btn-secondary !py-2 !px-4 !text-xs !rounded-full">
              Không gian đội →
            </Link>
          </div>
        </div>
      </div>

      {/* Featured / Running Spotlight */}
      {spotlight ? (
        <section
          aria-label="Giải đấu tiêu điểm"
          className="relative overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-6 shadow-sm hover:border-[var(--action)]/40 transition-colors"
        >
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-5">
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex items-center gap-2.5">
                <span
                  className={
                    spotlight.state === 'RUNNING'
                      ? 'inline-flex items-center gap-1.5 px-3 py-0.5 rounded-full text-[11px] font-bold font-mono uppercase tracking-wider bg-[rgba(255,70,85,0.12)] text-[var(--action)] border border-[rgba(255,70,85,0.3)]'
                      : 'inline-flex items-center gap-1.5 px-3 py-0.5 rounded-full text-[11px] font-bold font-mono uppercase tracking-wider bg-[var(--surface-subtle)] text-[var(--text-secondary)] border border-[var(--border-subtle)]'
                  }
                >
                  <span
                    className={
                      spotlight.state === 'RUNNING'
                        ? 'beacon-pulse'
                        : 'inline-block w-1.5 h-1.5 rounded-full bg-current'
                    }
                  />
                  {stateLabel[spotlight.state] ?? spotlight.state}
                </span>

                <span className="text-xs font-mono text-[var(--text-faint)]">
                  {spotlight.rulesRevision}
                </span>
                <span className="text-xs text-[var(--text-faint)]">·</span>
                <span className="text-xs text-[var(--text-secondary)] font-medium">
                  {formatLabel[spotlight.format] ?? spotlight.format}
                </span>
              </div>

              <h2 className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">
                {spotlight.name}
              </h2>

              <div className="flex flex-wrap items-center gap-4 text-xs text-[var(--text-secondary)]">
                <span>Tối đa {spotlight.maxTeams} đội</span>
                <span>·</span>
                <span>{spotlight.isRated ? 'Tính điểm Rating Global' : 'Không tính rating'}</span>
              </div>
            </div>

            <div className="flex items-center gap-3 shrink-0">
              <Link
                href={`/tournaments/${spotlight.id}`}
                className="vct-btn-primary !py-2.5 !px-5 !text-xs !rounded-full shadow-sm"
              >
                Vào xem giải đấu →
              </Link>
            </div>
          </div>
        </section>
      ) : null}

      {/* Catalog of all Tournaments */}
      <TournamentCatalog tournaments={tournaments} />
    </div>
  );
}
