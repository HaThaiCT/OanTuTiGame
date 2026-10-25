import Link from 'next/link';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import {
  getAuthProfile,
  getBracket,
  getMapCommitment,
  getMapPool,
  getOrganizerSession,
  getStandings,
  getTournament,
  getTournamentTeamRatings,
  listAnnouncements,
  listMaps,
  listTournamentEntries,
  listTournamentRegistrations,
  onlineTeams,
} from '../../../lib/api';
import { formatLabel, stateLabel } from '../../../lib/labels';
import { registrationStatusLabel } from '../../../lib/tournament-registration';
import AnnouncementsSection from './AnnouncementsSection';
import BracketSection from './BracketSection';
import { TeamRatingName } from '../../_components/TeamRatingName';
import { TournamentRatingProvider } from '../../_components/TournamentRatingContext';
import RatingStatus from './RatingStatus';
import TournamentRegistrationPanel from './TournamentRegistrationPanel';
import TournamentTeamPanel from './TournamentTeamPanel';
import TournamentStarterBotsPanel from './TournamentStarterBotsPanel';
import TournamentSubmissionsTab from './TournamentSubmissionsTab';
import OrganizerConsole from '../../organizer/OrganizerConsole';

export const dynamic = 'force-dynamic';

export default async function TournamentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const { id } = await params;
  const tournament = await getTournament(id);
  if (!tournament) notFound();

  const store = await cookies();
  const cookie = store.getAll().map((item) => `${item.name}=${item.value}`).join('; ');
  const session = await getOrganizerSession({ cookie });
  const isAdmin = session?.role === 'ADMIN' && session.scope === 'FULL';
  const isStudent = session?.role === 'STUDENT' && session.scope === 'FULL';

  const query = await searchParams;
  const rawTab = typeof query.tab === 'string' ? query.tab : 'overview';
  const validTabs = [
    'overview',
    'team',
    'registration',
    'submissions',
    'starter-bots',
    ...(isAdmin ? ['operations'] : []),
  ];
  const activeTab = validTabs.includes(rawTab) ? rawTab : 'overview';

  // Base data loaded for header and context
  const [commitment, teamRatings] = await Promise.all([
    getMapCommitment(id),
    getTournamentTeamRatings(id),
  ]);

  // Tab-specific data loading
  let bracket = null;
  let standings = null;
  let announcements = null;

  if (activeTab === 'overview') {
    [bracket, standings, announcements] = await Promise.all([
      getBracket(id),
      getStandings(id),
      listAnnouncements(id),
    ]);
  }

  // Student team eligibility check for submissions tab
  let studentApprovedTeam: { teamId: string; teamName: string } | null = null;
  let studentPendingTeam: { teamId: string; teamName: string; status: string } | null = null;
  let studentHasAnyTeam = false;

  if (isStudent && activeTab === 'submissions') {
    const [entriesRes, regsRes, teamsRes] = await Promise.all([
      listTournamentEntries(id, { cookie }),
      listTournamentRegistrations(id, { cookie }),
      onlineTeams.list({ cookie }),
    ]);

    const allTeams = teamsRes.ok && teamsRes.data ? teamsRes.data.teams : [];
    const myTeams = allTeams.filter((t) => session.teamIds.includes(t.id));
    const entries = entriesRes ?? [];
    const ownRegs = regsRes.ok && regsRes.data ? regsRes.data.registrations : [];

    const tournamentTeams = myTeams.filter(
      (t) =>
        t.tournamentId === id ||
        ownRegs.some((r) => r.teamId === t.id) ||
        entries.some((e) => e.teamId === t.id)
    );

    if (tournamentTeams.length > 0) {
      studentHasAnyTeam = true;
      for (const team of tournamentTeams) {
        const entry = entries.find((e) => e.teamId === team.id);
        const reg = ownRegs.find((r) => r.teamId === team.id);

        const isEligible = entry?.status === 'ELIGIBLE' || reg?.status === 'APPROVED';

        if (isEligible) {
          studentApprovedTeam = { teamId: team.id, teamName: team.name };
          break;
        } else if (!studentPendingTeam) {
          studentPendingTeam = {
            teamId: team.id,
            teamName: team.name,
            status: reg ? reg.status : entry ? entry.status : 'PENDING',
          };
        }
      }
    }
  }

  // Admin operations data
  let opData = null;
  if (isAdmin && activeTab === 'operations') {
    const [commitmentForOp, poolForOp, mapsForOp, entriesForOp, authProfileForOp] =
      await Promise.all([
        getMapCommitment(id, { cookie }),
        getMapPool(id, { cookie }),
        listMaps({ cookie }),
        tournament.state !== 'DRAFT' ? listTournamentEntries(id, { cookie }) : null,
        getAuthProfile({ cookie }),
      ]);
    opData = {
      commitment: commitmentForOp,
      pool: poolForOp,
      maps: mapsForOp,
      entries: entriesForOp,
      authProfile: authProfileForOp,
    };
  }

  const ratingsByTeam =
    teamRatings.kind === 'success'
      ? new Map(teamRatings.data.teams.map((team) => [team.teamId, team.rating]))
      : new Map();

  const showBuchholz =
    standings?.rows.some((row) => row.buchholz !== null && row.buchholz !== undefined) ?? false;
  const showRatingElo =
    standings?.rows.some((row) => row.ratingElo !== null && row.ratingElo !== undefined) ?? false;
  const standingsColumns = 6 + (showBuchholz ? 1 : 0) + (showRatingElo ? 1 : 0);

  const tabs = [
    { id: 'overview', label: 'Tổng quan' },
    { id: 'team', label: 'Đội thi đấu' },
    { id: 'registration', label: 'Đăng ký tham gia' },
    { id: 'submissions', label: 'Bài nộp & Test' },
    { id: 'starter-bots', label: 'Bot mẫu & Chạy local' },
    ...(isAdmin ? [{ id: 'operations', label: 'Điều hành (Admin)' }] : []),
  ] as const;

  return (
    <TournamentRatingProvider
      tournamentId={id}
      initial={teamRatings.kind === 'success' ? teamRatings.data : null}
    >
      <div className="flex min-w-0 flex-col gap-6">
        {/* Top Breadcrumb & Actions */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <nav className="flex min-w-0 flex-wrap items-center gap-2 font-mono text-xs text-[var(--text-secondary)] uppercase">
            <Link href="/" className="hover:text-[var(--action)]">
              TRANG CHỦ
            </Link>
            <span>/</span>
            <Link href="/tournaments" className="hover:text-[var(--action)]">
              GIẢI ĐẤU
            </Link>
            <span>/</span>
            <span className="text-[var(--text-primary)] font-medium truncate max-w-xs">
              {tournament.name}
            </span>
          </nav>

          <div className="flex items-center gap-3 ml-auto">
            <Link
              className="vct-btn-secondary !py-2 !px-4 !text-xs !rounded-full"
              href={`/projector/${tournament.id}`}
            >
              Chế độ trình chiếu →
            </Link>
          </div>
        </div>

        {/* Responsive Header: Status badges on their own row, title gets 100% width on 390px mobile */}
        <header className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-5 sm:p-7 shadow-sm">
          <div className="flex flex-col gap-4">
            {/* Status row: format, state badge, and unrated tag on their own flex row */}
            <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-[var(--border-subtle)] pb-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs font-semibold uppercase tracking-wider text-[var(--accent-secondary)]">
                  {formatLabel[tournament.format] ?? tournament.format}
                </span>
                <span className="text-[var(--border-subtle)]">·</span>
                <span className="flex items-center gap-1.5 font-mono text-xs font-bold uppercase text-[var(--live-accent)]">
                  <span className="inline-block h-2 w-2 rounded-full bg-[var(--live-accent)] animate-pulse" />
                  {stateLabel[tournament.state] ?? tournament.state}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`rounded-full px-3 py-1 font-mono text-[10px] font-bold tracking-widest uppercase shadow-xs ${
                    tournament.isRated
                      ? 'bg-[var(--action)] text-[var(--action-text)]'
                      : 'border border-[var(--border-subtle)] bg-[var(--surface-subtle)] text-[var(--text-secondary)]'
                  }`}
                >
                  {tournament.isRated ? 'RATED' : 'UNRATED'}
                </span>
              </div>
            </div>

            {/* Title with full width so Vietnamese names wrap cleanly without column squishing */}
            <div className="w-full">
              <h1 className="w-full break-words font-heading text-2xl font-bold tracking-tight text-[var(--text-primary)] md:text-3xl leading-tight">
                {tournament.name}
              </h1>
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-[var(--text-secondary)]">
                <span>
                  Luật thi đấu: <strong className="font-medium text-[var(--text-primary)]">{tournament.rulesRevision}</strong>
                </span>
                <span>·</span>
                <span>
                  Quy mô tối đa: <strong className="font-medium text-[var(--text-primary)]">{tournament.maxTeams} đội</strong>
                </span>
                {commitment ? (
                  <>
                    <span>·</span>
                    <span>
                      Bản đồ:{' '}
                      <strong className="font-medium text-[var(--text-primary)]">
                        {commitment.displayName} (v{commitment.version})
                      </strong>
                    </span>
                  </>
                ) : null}
                {tournament.registrationClosesAt ? (
                  <>
                    <span>·</span>
                    <span>
                      Hạn đăng ký:{' '}
                      <strong className="font-medium text-[var(--text-primary)]">
                        {tournament.registrationClosesAt.slice(0, 16).replace('T', ' ')} UTC
                      </strong>
                    </span>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        </header>

        {/* Tab Navigation Bar */}
        <nav
          aria-label="Điều hướng giải đấu"
          className="flex items-center gap-2 overflow-x-auto border-b border-[var(--border-subtle)] pb-2 pt-1 no-scrollbar"
        >
          {tabs.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <Link
                key={tab.id}
                href={`/tournaments/${encodeURIComponent(id)}?tab=${tab.id}`}
                scroll={false}
                style={isActive ? { color: 'var(--action-text)' } : undefined}
                className={`whitespace-nowrap rounded-xl px-4 py-2.5 font-heading text-xs font-bold transition-all ${
                  isActive
                    ? 'bg-[var(--action)] text-[var(--action-text)] shadow-xs'
                    : 'border border-[var(--border-subtle)] bg-[var(--surface)] text-[var(--text-secondary)] hover:border-[var(--border-control)] hover:text-[var(--text-primary)]'
                }`}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>

        {/* TAB 1: OVERVIEW */}
        {activeTab === 'overview' && (
          <div className="flex flex-col gap-6">
            {tournament.state === 'PROVISIONAL' ? (
              <div className="rounded-xl border border-[var(--warning-text)] bg-[var(--warning-tint)] px-4 py-3 text-xs text-[var(--warning-text)] shadow-xs">
                <span className="font-semibold">Kết quả tạm tính:</span> Bảng xếp hạng và nhánh đấu có thể thay đổi sau khi xử lý kháng nghị.
              </div>
            ) : tournament.state === 'FINALIZED' ? (
              <div className="rounded-xl border border-[var(--success-text)] bg-[var(--success-tint)] px-4 py-3 text-xs text-[var(--success-text)] shadow-xs">
                <span className="font-semibold">Kết quả chính thức:</span> Mọi điều chỉnh sau khi chốt sẽ được ghi nhận trong Thông báo.
              </div>
            ) : null}

            <BracketSection
              encounters={bracket?.encounters ?? null}
              rounds={bracket?.rounds ?? []}
              canViewReplay={isAdmin}
              format={tournament.format}
            />

            <RatingStatus tournamentId={id} isRated={tournament.isRated} />

            <AnnouncementsSection announcements={announcements} />

            {/* Standings Table */}
            <section className="min-w-0 overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-5 py-4">
                <div>
                  <h2 className="font-heading text-lg font-bold text-[var(--text-primary)]">
                    Bảng xếp hạng
                  </h2>
                  <p className="text-xs text-[var(--text-secondary)]">
                    Stage {standings?.stage ?? 1} · Vòng {standings?.round || '—'}
                  </p>
                </div>
                <span className="rounded-full border border-[var(--border-subtle)] px-2.5 py-1 font-mono text-xs text-[var(--text-secondary)]">
                  {standings?.rows.length ?? 0} ĐỘI
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] border-collapse text-sm">
                  <thead className="border-b border-[var(--border-subtle)] bg-[var(--surface-subtle)] text-left font-heading text-xs uppercase tracking-wider text-[var(--text-secondary)]">
                    <tr>
                      <th className="w-16 px-5 py-3">HẠNG</th>
                      <th className="px-5 py-3">CHIẾN ĐỘI</th>
                      <th className="px-5 py-3 text-center">ĐÃ ĐẤU</th>
                      <th className="px-5 py-3 text-center">T–H–B</th>
                      <th className="px-5 py-3 text-center">ĐIỂM</th>
                      {showBuchholz && <th className="px-5 py-3 text-center">BUCHHOLZ</th>}
                      {showRatingElo && <th className="px-5 py-3 text-center">ELO TRONG GIẢI</th>}
                      <th className="px-5 py-3 text-center">TRẠNG THÁI</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!standings || standings.rows.length === 0 ? (
                      <tr>
                        <td
                          colSpan={standingsColumns}
                          className="px-6 py-12 text-center font-mono text-xs text-[var(--text-secondary)]"
                        >
                          // CHƯA CÓ BẢNG XẾP HẠNG ĐƯỢC CHẤP NHẬN CHO VÒNG NÀY.
                        </td>
                      </tr>
                    ) : (
                      standings.rows.map((row) => (
                        <tr
                          key={row.teamId}
                          className={`border-t border-[var(--border-subtle)] hover:bg-[var(--surface-subtle)] transition-colors ${
                            row.isQualified ? 'bg-[rgba(0,245,212,0.04)]' : ''
                          }`}
                        >
                          <td className="px-5 py-3.5 font-mono font-bold text-[var(--action)]">
                            #{String(row.rank).padStart(2, '0')}
                          </td>
                          <td className="px-5 py-3.5 font-medium">
                            <TeamRatingName
                              teamId={row.teamId}
                              name={row.teamName}
                              rating={ratingsByTeam.get(row.teamId) ?? null}
                            />
                          </td>
                          <td className="px-5 py-3.5 text-center font-mono">{row.matchesPlayed}</td>
                          <td className="px-5 py-3.5 text-center font-mono text-[var(--text-secondary)]">
                            {row.wins}–{row.draws}–{row.losses}
                          </td>
                          <td className="px-5 py-3.5 text-center font-mono font-bold text-[var(--text-primary)]">
                            {row.points}
                          </td>
                          {showBuchholz && (
                            <td className="px-5 py-3.5 text-center font-mono text-[var(--text-secondary)]">
                              {row.buchholz ?? '—'}
                            </td>
                          )}
                          {showRatingElo && (
                            <td className="px-5 py-3.5 text-center font-mono text-[var(--text-secondary)]">
                              {row.ratingElo ?? '—'}
                            </td>
                          )}
                          <td className="px-5 py-3.5 text-center">
                            {row.isQualified ? (
                              <span className="rounded-full border border-[var(--success-text)] bg-[var(--success-tint)] px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-[var(--success-text)]">
                                ĐỦ ĐIỀU KIỆN
                              </span>
                            ) : (
                              <span className="font-mono text-[11px] uppercase text-[var(--text-secondary)]">
                                ĐANG ĐẤU
                              </span>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}

        {/* TAB 2: MY TEAM */}
        {activeTab === 'team' && (
          <div className="flex flex-col gap-6">
            <TournamentTeamPanel
              tournamentId={id}
              tournamentState={tournament.state}
              tournamentName={tournament.name}
            />
          </div>
        )}

        {/* TAB 3: REGISTRATION */}
        {activeTab === 'registration' && (
          <div id="registration" className="scroll-mt-24">
            <TournamentRegistrationPanel
              tournamentId={id}
              state={tournament.state}
              registrationClosesAt={tournament.registrationClosesAt}
            />
          </div>
        )}

        {/* TAB 4: SUBMISSIONS & PRIVATE TESTS */}
        {activeTab === 'submissions' && (
          <div className="flex flex-col gap-6">
            {!session ? (
              <section className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-6 shadow-sm">
                <h2 className="font-heading text-xl font-bold tracking-tight text-[var(--text-primary)]">
                  Bài nộp & Test riêng tư
                </h2>
                <p className="mt-2 text-sm text-[var(--text-secondary)] leading-relaxed">
                  Đăng nhập bằng tài khoản sinh viên có đội thi đấu để nộp bài thi đấu chính thức và chạy thử nghiệm bot riêng tư trong sandbox.
                </p>
                <div className="mt-6">
                  <Link
                    href={`/workspace?returnTo=${encodeURIComponent(`/tournaments/${id}?tab=submissions`)}`}
                    className="vct-btn-primary inline-flex items-center gap-2 !py-2.5 !px-5 !text-sm !rounded-full"
                  >
                    Đăng nhập để nộp bài →
                  </Link>
                </div>
              </section>
            ) : !isStudent ? (
              <section className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-6 shadow-sm">
                <h2 className="font-heading text-xl font-bold text-[var(--text-primary)]">
                  Quyền hạn nộp bài
                </h2>
                <p className="mt-2 text-sm text-[var(--text-secondary)]">
                  Tài khoản hiện tại có vai trò <strong>{session.role}</strong>. Chỉ tài khoản sinh viên đại diện đội thi đấu mới nộp bài và chạy test.
                </p>
              </section>
            ) : studentApprovedTeam ? (
              <TournamentSubmissionsTab
                tournamentId={id}
                teamId={studentApprovedTeam.teamId}
                teamName={studentApprovedTeam.teamName}
                tournamentState={tournament.state}
              />
            ) : studentPendingTeam ? (
              <section className="rounded-2xl border border-[var(--warning-text)] bg-[var(--surface)] p-6 shadow-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full border border-[var(--warning-text)] bg-[var(--warning-tint)] px-3 py-1 font-mono text-xs font-bold text-[var(--warning-text)]">
                    {(registrationStatusLabel as Record<string, string>)[studentPendingTeam.status] ?? studentPendingTeam.status}
                  </span>
                  <h2 className="font-heading text-xl font-bold tracking-tight text-[var(--text-primary)]">
                    Đội “{studentPendingTeam.teamName}” chưa được mở quyền nộp bài
                  </h2>
                </div>
                <p className="mt-3 text-sm text-[var(--text-secondary)] leading-relaxed">
                  Đăng ký tham gia của đội bạn đang ở trạng thái <strong>{(registrationStatusLabel as Record<string, string>)[studentPendingTeam.status] ?? studentPendingTeam.status}</strong>. Chỉ đội đã được Ban tổ chức phê duyệt (APPROVED hoặc ELIGIBLE) mới có quyền nộp bài thi đấu và chạy kiểm thử riêng tư.
                </p>
                <div className="mt-6 flex flex-wrap items-center gap-3">
                  <Link
                    href={`/tournaments/${encodeURIComponent(id)}?tab=registration`}
                    className="vct-btn-primary !py-2.5 !px-5 !text-xs !rounded-full"
                  >
                    Xem trạng thái tại tab Đăng ký tham gia →
                  </Link>
                </div>
              </section>
            ) : (
              <section className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-6 shadow-sm">
                <h2 className="font-heading text-xl font-bold tracking-tight text-[var(--text-primary)]">
                  Chưa có đội thi đấu trong giải này
                </h2>
                <p className="mt-2 text-sm text-[var(--text-secondary)] leading-relaxed">
                  Bạn cần có đội thi đấu và được Ban tổ chức duyệt tham gia giải trước khi có thể nộp bài hoặc chạy test riêng tư.
                </p>
                <div className="mt-6 flex flex-wrap items-center gap-3">
                  <Link
                    href={`/tournaments/${encodeURIComponent(id)}?tab=team`}
                    className="vct-btn-primary !py-2.5 !px-5 !text-xs !rounded-full"
                  >
                    Tạo hoặc xem đội tại tab Đội thi đấu →
                  </Link>
                </div>
              </section>
            )}
          </div>
        )}

        {/* TAB 5: STARTER BOTS */}
        {activeTab === 'starter-bots' && (
          <div className="flex flex-col gap-6">
            <TournamentStarterBotsPanel />
          </div>
        )}

        {/* TAB 6: OPERATIONS (ADMIN ONLY) */}
        {activeTab === 'operations' && isAdmin && opData && (
          <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-5 shadow-sm">
              <div>
                <h2 className="font-heading text-xl font-bold tracking-tight text-[var(--text-primary)]">
                  Bảng điều hành Ban tổ chức (Admin Operations)
                </h2>
                <p className="mt-1 text-xs text-[var(--text-secondary)]">
                  Điều khiển vòng đời giải đấu, cấu hình bản đồ, duyệt danh sách và chạy các ván đấu đang chờ.
                </p>
              </div>
              <Link
                href={`/organizer/tournaments/${encodeURIComponent(id)}`}
                className="vct-btn-secondary inline-flex items-center gap-1.5 !py-2.5 !px-5 !text-xs !rounded-full"
              >
                <span>Mở Console đầy đủ</span>
                <span>→</span>
              </Link>
            </div>

            <OrganizerConsole
              key={id}
              section="operations"
              tournaments={[tournament]}
              authProfile={opData.authProfile}
              maps={opData.maps}
              entriesByTournament={{ [id]: opData.entries }}
              commitmentsByTournament={{ [id]: opData.commitment }}
              poolsByTournament={{ [id]: opData.pool }}
            />
          </div>
        )}
      </div>
    </TournamentRatingProvider>
  );
}
