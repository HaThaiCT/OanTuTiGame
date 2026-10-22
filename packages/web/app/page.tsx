import Link from 'next/link';
import FeaturedRanking from './_components/FeaturedRanking';
import NewsSection from './_components/NewsSection';
import { getBracket, getGlobalTeamLeaderboard, listNews, listTournaments, type TournamentSummary } from '../lib/api';
import { formatLabel, stateLabel } from '../lib/labels';
import { selectHomepageTournaments } from '../lib/homepage-tournaments';

export const dynamic = 'force-dynamic';

interface RecentMatchItem {
  tournamentId: string;
  tournamentName: string;
  encounterId: string;
  teamAName: string;
  teamBName: string;
  pointsA: string | number;
  pointsB: string | number;
  status: string;
  gameId?: string;
}

export default async function HomePage() {
  const [tournaments, ratings, newsResult] = await Promise.all([
    listTournaments(),
    getGlobalTeamLeaderboard({ limit: 8 }),
    listNews({ limit: 10 }),
  ]);

  // Extract recent matches with games for the match ticker
  const recentMatches: RecentMatchItem[] = [];
  for (const t of tournaments) {
    if (recentMatches.length >= 6) break;
    const b = await getBracket(t.id);
    if (!b?.encounters) continue;
    for (const m of b.encounters) {
      if (m.games && m.games.length > 0 && m.teamAName && m.teamBName) {
        recentMatches.push({
          tournamentId: t.id,
          tournamentName: t.name,
          encounterId: m.encounterId,
          teamAName: m.teamAName,
          teamBName: m.teamBName,
          pointsA: m.pointsA ?? 0,
          pointsB: m.pointsB ?? 0,
          status: m.status,
          gameId: m.games[0]?.gameId,
        });
        if (recentMatches.length >= 6) break;
      }
    }
  }

  const { spotlight, featured: otherFeatured } = selectHomepageTournaments(tournaments);

  return (
    <div className="space-y-6">
      <h1 className="sr-only">OanTuTi Arena — giải đấu lập trình bot và bản tin chính thức</h1>

      {/* Codeforces-Style Two-Column Hub Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] xl:grid-cols-[1fr_400px] gap-8 items-start">
        {/* PRIMARY MAIN COLUMN: News & Announcements Blog Feed */}
        <main className="min-w-0 space-y-6" id="news">
          <NewsSection posts={newsResult.ok && newsResult.data ? newsResult.data.posts : []} />
        </main>

        {/* RIGHT SIDEBAR: Competitive Widgets */}
        <aside className="space-y-6 lg:sticky lg:top-24">
          {/* 1. Spotlight Tournament */}
          {spotlight ? (
            <section
              aria-label="Giải đấu tiêu điểm"
              className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-5 shadow-xs space-y-3.5 hover:border-[var(--action)]/40 transition-colors"
            >
              <div className="flex items-center justify-between text-xs">
                <span className="font-bold uppercase tracking-wider text-[var(--action)] font-mono text-[11px] flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-[var(--action)] animate-pulse" />
                  Giải đấu tiêu điểm
                </span>
                <span
                  className={
                    spotlight.state === 'RUNNING'
                      ? 'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold font-mono uppercase tracking-wider bg-[rgba(255,70,85,0.12)] text-[var(--action)] border border-[rgba(255,70,85,0.3)]'
                      : 'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold font-mono uppercase tracking-wider bg-[var(--surface-subtle)] text-[var(--text-secondary)] border border-[var(--border-subtle)]'
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
              </div>

              <div>
                <h3 className="text-lg font-bold text-[var(--text-primary)] leading-snug">
                  <Link
                    href={`/tournaments/${spotlight.id}`}
                    className="hover:text-[var(--action)] transition-colors"
                  >
                    {spotlight.name}
                  </Link>
                </h3>
                <div className="flex flex-wrap items-center gap-2 mt-1.5 text-xs text-[var(--text-secondary)]">
                  <span>{formatLabel[spotlight.format] ?? spotlight.format}</span>
                  <span>·</span>
                  <span>Tối đa {spotlight.maxTeams} đội</span>
                  <span>·</span>
                  <span className="font-mono text-[11px]">
                    {spotlight.isRated ? 'RATED' : 'UNRATED'}
                  </span>
                </div>
              </div>

              <div className="pt-1">
                <Link
                  href={`/tournaments/${spotlight.id}`}
                  className="vct-btn-primary !w-full !py-2.5 !text-xs !rounded-xl block text-center"
                >
                  Vào xem giải đấu →
                </Link>
              </div>
            </section>
          ) : null}

          {/* 2. Ongoing & Upcoming Contests */}
          <section
            aria-label="Giải đấu sắp tới"
            className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-5 shadow-xs space-y-3.5"
          >
            <div className="flex items-center justify-between pb-2 border-b border-[var(--border-subtle)]">
              <h3 className="font-bold text-sm text-[var(--text-primary)]">
                Giải đấu sắp tới & đang mở
              </h3>
              <Link
                href="/tournaments"
                className="text-[11px] font-mono text-[var(--action)] hover:underline"
              >
                Tất cả ({tournaments.length}) →
              </Link>
            </div>

            {otherFeatured.length === 0 ? (
              <p className="text-xs text-[var(--text-secondary)] py-2">
                Hiện chưa có giải đấu sắp tới khác.
              </p>
            ) : (
              <div className="space-y-2.5">
                {otherFeatured.map((t) => (
                  <Link
                    key={t.id}
                    href={`/tournaments/${t.id}`}
                    className="block p-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)] hover:border-[var(--border-control)] hover:bg-[var(--surface-accent)]/30 transition-all group"
                  >
                    <div className="flex items-center justify-between text-[11px] mb-1">
                      <span className="font-mono text-[var(--text-secondary)] font-medium">
                        {stateLabel[t.state] ?? t.state}
                      </span>
                      <span className="font-mono text-[10px] px-1.5 py-0.2 rounded border border-[var(--border-subtle)] bg-[var(--surface)] text-[var(--text-faint)]">
                        {t.isRated ? 'RATED' : 'UNRATED'}
                      </span>
                    </div>
                    <h4 className="font-bold text-xs text-[var(--text-primary)] group-hover:text-[var(--action)] transition-colors truncate">
                      {t.name}
                    </h4>
                    <div className="mt-1 flex items-center justify-between text-[11px] text-[var(--text-secondary)]">
                      <span>{formatLabel[t.format] ?? t.format}</span>
                      <span className="font-mono text-[10px] text-[var(--text-faint)]">
                        Tối đa {t.maxTeams} đội
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </section>

          {/* 3. Global Leaderboard (Top 8) */}
          <FeaturedRanking leaderboard={ratings.kind === 'success' ? ratings.data : null} />

          {/* 4. Recent Matches Ticker & Encounters */}
          {recentMatches.length > 0 ? (
            <section
              aria-label="Trận đấu gần đây"
              className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-5 shadow-xs space-y-3.5"
            >
              <div className="flex items-center justify-between pb-2 border-b border-[var(--border-subtle)]">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-[var(--action)] animate-pulse" />
                  <h3 className="font-bold text-sm text-[var(--text-primary)]">
                    Trận đấu gần đây
                  </h3>
                </div>
                <span className="text-[10px] font-mono text-[var(--text-faint)]">
                  LIVE
                </span>
              </div>

              <div className="divide-y divide-[var(--border-subtle)]">
                {recentMatches.slice(0, 5).map((m, idx) => (
                  <div
                    key={`${m.encounterId}-${idx}`}
                    className="py-2.5 first:pt-0 last:pb-0 space-y-1.5"
                  >
                    <div className="flex items-center justify-between text-[10.5px] font-mono text-[var(--text-faint)]">
                      <span className="truncate max-w-[180px]">{m.tournamentName}</span>
                      <span className="text-[10px] uppercase">{m.status}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span
                        className="font-medium text-[var(--text-primary)] truncate max-w-[110px]"
                        title={m.teamAName}
                      >
                        {m.teamAName}
                      </span>
                      <span className="font-mono font-bold text-xs px-2 py-0.5 rounded bg-[var(--surface-subtle)] text-[var(--text-primary)] shrink-0">
                        {m.pointsA} : {m.pointsB}
                      </span>
                      <span
                        className="font-medium text-[var(--text-secondary)] truncate max-w-[110px] text-right"
                        title={m.teamBName}
                      >
                        {m.teamBName}
                      </span>
                    </div>
                    {m.gameId ? (
                      <div className="text-right">
                        <Link
                          href={`/tournaments/${encodeURIComponent(m.tournamentId)}`}
                          className="text-[10.5px] font-mono font-semibold text-[var(--action)] hover:underline inline-flex items-center gap-0.5"
                        >
                          Chi tiết giải đấu →
                        </Link>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {/* 5. Candidate & Team Workspace Card */}
          <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-5 shadow-xs space-y-3">
            <h3 className="font-bold text-sm text-[var(--text-primary)]">
              Không gian thí sinh & Đội tuyển
            </h3>
            <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
              Lập trình bot bằng Python, TypeScript hoặc C++20. Tích hợp Monaco Editor trực tiếp, nộp mã nguồn và chạy thử nghiệm an toàn.
            </p>
            <div className="pt-1">
              <Link
                href="/tournaments"
                className="vct-btn-secondary !w-full !py-2.5 !text-xs !rounded-xl block text-center font-mono"
              >
                Xem danh sách giải đấu →
              </Link>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
