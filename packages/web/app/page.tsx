import Link from 'next/link';
import FeaturedRanking from './_components/FeaturedRanking';
import { getGlobalTeamLeaderboard, listTournaments } from '../lib/api';
import TournamentCatalog from './_components/TournamentCatalog';
import { formatLabel, stateLabel } from '../lib/labels';

export default async function HomePage() {
  const [tournaments, ratings] = await Promise.all([
    listTournaments(),
    getGlobalTeamLeaderboard({ limit: 8 }),
  ]);

  const runningTournament = tournaments.find(t => t.state === 'RUNNING') ?? tournaments[0];

  return (
    <div className="space-y-8">
      {/* Spotlight: Active or Major Tournament Banner */}
      {runningTournament ? (
        <section
          aria-label="Giải đấu tiêu điểm"
          className="relative overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-5 sm:p-6 shadow-sm hover:border-[var(--action)]/40 transition-colors"
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2.5 mb-2">
                <span
                  className={
                    runningTournament.state === 'RUNNING'
                      ? 'inline-flex items-center gap-1.5 px-3 py-0.5 rounded-full text-[11px] font-bold font-mono uppercase tracking-wider bg-[rgba(255,70,85,0.12)] text-[var(--action)] border border-[rgba(255,70,85,0.3)]'
                      : 'inline-flex items-center gap-1.5 px-3 py-0.5 rounded-full text-[11px] font-bold font-mono uppercase tracking-wider bg-[var(--surface-subtle)] text-[var(--text-secondary)] border border-[var(--border-subtle)]'
                  }
                >
                  <span
                    className={
                      runningTournament.state === 'RUNNING'
                        ? 'beacon-pulse'
                        : 'inline-block w-1.5 h-1.5 rounded-full bg-current'
                    }
                  />
                  {stateLabel[runningTournament.state] ?? runningTournament.state}
                </span>

                <span className="text-xs font-mono text-[var(--text-faint)]">
                  {runningTournament.rulesRevision}
                </span>
              </div>

              <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-[var(--text-primary)] truncate">
                {runningTournament.name}
              </h2>

              <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-[var(--text-secondary)] font-medium">
                <span>{formatLabel[runningTournament.format] ?? runningTournament.format}</span>
                <span>·</span>
                <span>Tối đa {runningTournament.maxTeams} đội</span>
                <span>·</span>
                <span>{runningTournament.isRated ? 'Tính điểm Rating Global' : 'Không tính rating'}</span>
              </div>
            </div>

            <div className="flex items-center gap-3 shrink-0">
              <Link
                href={`/tournaments/${runningTournament.id}`}
                className="vct-btn-primary !py-2.5 !px-5 !text-xs !rounded-full shadow-sm"
              >
                Vào xem giải đấu →
              </Link>
            </div>
          </div>
        </section>
      ) : null}

      {/* Main Competition Hub: Tournament Stream + Rankings Sidebar */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] xl:grid-cols-[1fr_380px] gap-8 items-start">
        {/* Main Column: All Tournaments */}
        <div className="min-w-0">
          <TournamentCatalog tournaments={tournaments} />
        </div>

        {/* Sidebar Column: Standings & Team Tools */}
        <aside className="space-y-6 lg:sticky lg:top-24">
          <FeaturedRanking leaderboard={ratings.kind === 'success' ? ratings.data : null} />

          <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-5 shadow-sm space-y-3">
            <h3 className="font-bold text-sm text-[var(--text-primary)]">
              Không gian thi đấu
            </h3>
            <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
              Lập trình bot bằng Python, TypeScript hoặc C++. Nộp mã nguồn, chạy kiểm thử nội bộ và theo dõi replay trực tiếp.
            </p>
            <Link
              href="/workspace"
              className="vct-btn-secondary !w-full !py-2 !text-xs !rounded-xl block text-center"
            >
              Vào Không gian đội →
            </Link>
          </div>
        </aside>
      </div>
    </div>
  );
}
