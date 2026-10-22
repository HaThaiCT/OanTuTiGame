import Link from 'next/link';
import FeaturedRanking from './_components/FeaturedRanking';
import { getBracket, getGlobalTeamLeaderboard, listTournaments, type TournamentSummary } from '../lib/api';
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
  const [tournaments, ratings] = await Promise.all([
    listTournaments(),
    getGlobalTeamLeaderboard({ limit: 8 }),
  ]);

  // Extract recent matches with games for the match strip
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
      <h1 className="sr-only">OanTuTi Arena — giải đấu lập trình bot</h1>
      {/* 1. Live & Recent Match Strip (Ticker) */}
      {recentMatches.length > 0 ? (
        <section aria-label="Trận đấu gần đây" className="relative">
          <div className="flex items-center justify-between text-xs font-mono text-[var(--text-secondary)] mb-2 px-1">
            <span className="flex items-center gap-2 font-bold uppercase tracking-wider text-[var(--text-primary)]">
              <span className="w-2 h-2 rounded-full bg-[var(--action)] animate-pulse" />
              Trận đấu gần đây
            </span>
            <Link href="/tournaments" className="hover:text-[var(--text-primary)] transition-colors">
              Xem tất cả giải đấu ({tournaments.length}) →
            </Link>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {recentMatches.slice(0, 3).map((match, idx) => (
              <div
                key={`${match.encounterId}-${idx}`}
                className="flex items-center justify-between rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] p-3 text-xs shadow-xs hover:border-[var(--border-control)] transition-all"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="font-mono text-[10px] text-[var(--text-faint)] truncate">
                    {match.tournamentName}
                  </p>
                  <div className="flex items-center justify-between font-medium pr-3">
                    <span className="truncate max-w-[90px] text-[var(--text-primary)] font-semibold">
                      {match.teamAName}
                    </span>
                    <span className="font-mono font-bold text-[var(--text-primary)] bg-[var(--surface-subtle)] px-2 py-0.5 rounded-md">
                      {match.pointsA} : {match.pointsB}
                    </span>
                    <span className="truncate max-w-[90px] text-[var(--text-secondary)]">
                      {match.teamBName}
                    </span>
                  </div>
                </div>

                {match.gameId ? (
                  <Link
                    href={`/replays?game=${encodeURIComponent(match.gameId)}`}
                    className="shrink-0 font-mono text-[11px] font-bold text-[var(--action)] hover:underline border-l border-[var(--border-subtle)] pl-3 ml-1"
                    title="Xem replay ván đấu"
                  >
                    Replay →
                  </Link>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* 2. Main Competitive Hub Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] xl:grid-cols-[1fr_380px] gap-6 items-start">
        {/* Left Column: Spotlight Tournament + Tournament Feed + Recent Match Log */}
        <div className="space-y-6 min-w-0">
          {/* Spotlight Stage Banner */}
          {spotlight ? (
            <section
              aria-label="Giải đấu tiêu điểm"
              className="relative overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-6 shadow-sm hover:border-[var(--action)]/40 transition-colors"
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-5">
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

                  <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--text-secondary)]">
                    <span>Tối đa {spotlight.maxTeams} đội</span>
                    <span>·</span>
                    <span>{spotlight.isRated ? 'Tính điểm Rating Global' : 'Không tính rating'}</span>
                  </div>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  <Link
                    href={`/tournaments/${spotlight.id}`}
                    className="vct-btn-primary !py-3 !px-6 !text-sm !rounded-full shadow-sm"
                  >
                    Vào xem giải đấu →
                  </Link>
                </div>
              </div>
            </section>
          ) : null}

          {/* Featured Tournaments Grid */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-[var(--text-primary)]">
                Giải đấu đang diễn ra & sắp tới
              </h2>
              <Link href="/tournaments" className="text-xs font-semibold text-[var(--action)] hover:underline">
                Xem toàn bộ {tournaments.length} giải đấu →
              </Link>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {otherFeatured.map((t) => (
                <Link
                  key={t.id}
                  href={`/tournaments/${t.id}`}
                  className="flex flex-col justify-between rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] p-4 shadow-xs hover:border-[var(--border-control)] transition-all hover:-translate-y-0.5"
                >
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-mono text-[10px] text-[var(--text-secondary)]">
                        {stateLabel[t.state] ?? t.state}
                      </span>
                      <span className="font-mono text-[10px] px-2 py-0.2 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-subtle)] text-[var(--text-faint)]">
                        {t.isRated ? 'RATED' : 'UNRATED'}
                      </span>
                    </div>
                    <h3 className="font-bold text-sm text-[var(--text-primary)] truncate">
                      {t.name}
                    </h3>
                    <p className="text-xs text-[var(--text-secondary)]">
                      {formatLabel[t.format] ?? t.format} · Tối đa {t.maxTeams} đội
                    </p>
                  </div>

                  <div className="mt-3 pt-2 border-t border-[var(--border-subtle)] flex items-center justify-between text-xs">
                    <span className="text-[var(--text-faint)] font-mono text-[11px]">
                      {t.rulesRevision}
                    </span>
                    <span className="font-semibold text-[var(--action)]">
                      Xem chi tiết →
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          </section>

          {/* Recent Match Encounters List */}
          {recentMatches.length > 0 ? (
            <section className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-5 shadow-sm space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-bold text-[var(--text-primary)]">
                  Kết quả các trận đối đầu mới nhất
                </h2>
                <span className="text-xs font-mono text-[var(--text-secondary)]">
                  Cập nhật theo thời gian thực
                </span>
              </div>

              <div className="divide-y divide-[var(--border-subtle)]">
                {recentMatches.slice(0, 5).map((m, idx) => (
                  <div
                    key={`${m.encounterId}-row-${idx}`}
                    className="py-3 flex items-center justify-between gap-4 text-xs"
                  >
                    <div className="min-w-0 flex-1 flex items-center gap-3">
                      <span className="font-mono text-[10px] text-[var(--text-faint)] w-28 truncate hidden sm:inline">
                        {m.tournamentName}
                      </span>
                      <span className="font-semibold text-[var(--text-primary)] truncate max-w-[120px]">
                        {m.teamAName}
                      </span>
                      <span className="font-mono font-bold px-2 py-0.5 rounded bg-[var(--surface-subtle)] text-[var(--text-primary)]">
                        {m.pointsA} – {m.pointsB}
                      </span>
                      <span className="text-[var(--text-secondary)] truncate max-w-[120px]">
                        {m.teamBName}
                      </span>
                    </div>

                    {m.gameId ? (
                      <Link
                        href={`/replays?game=${encodeURIComponent(m.gameId)}`}
                        className="vct-btn-secondary !py-1.5 !px-3.5 !text-xs !rounded-full shrink-0"
                      >
                        Xem Replay
                      </Link>
                    ) : (
                      <span className="text-[var(--text-faint)] font-mono text-[11px]">
                        {m.status}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>

        {/* Right Column: Global Standings + Team Quick Actions */}
        <aside className="space-y-6 lg:sticky lg:top-24">
          <FeaturedRanking leaderboard={ratings.kind === 'success' ? ratings.data : null} />

          <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-5 shadow-sm space-y-3.5">
            <h3 className="font-bold text-sm text-[var(--text-primary)]">
              Không gian thí sinh & Đội tuyển
            </h3>
            <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
              Lập trình bot bằng Python, TypeScript hoặc C++20. Tích hợp Monaco Editor trực tiếp, nộp mã nguồn và chạy thử nghiệm an toàn.
            </p>
            <div className="pt-1">
              <Link
                href="/workspace"
                className="vct-btn-primary !w-full !py-3 !text-sm !rounded-full block text-center"
              >
                Vào Không gian đội →
              </Link>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
