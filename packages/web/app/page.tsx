import Link from 'next/link';
import FeaturedRanking from './_components/FeaturedRanking';
import { getGlobalTeamLeaderboard, listTournaments } from '../lib/api';
import { formatLabel, stateLabel } from '../lib/labels';
import TrinityBattleWheel from './_components/TrinityBattleWheel';

export const dynamic = 'force-dynamic';

const MODES = [
  {
    id: 'SINGLE_ELIMINATION',
    name: 'Loại trực tiếp',
    desc: 'Thi đấu knock-out một mất một còn. Đội chiến thắng đi tiếp vào trận Chung kết.',
    icon: '⚡',
    badge: 'Knock-out',
  },
  {
    id: 'SWISS_PLAYOFF',
    name: 'Swiss → Playoff',
    desc: 'Phân tầng ghép cặp theo điểm số qua từng vòng, chọn các đội hạt giống vào Playoff.',
    icon: '⚔️',
    badge: 'Cân bằng',
  },
  {
    id: 'ROUND_ROBIN',
    name: 'Vòng tròn tính điểm',
    desc: 'Thử thách thuật toán bền bỉ, thi đấu xoay vòng tính điểm toàn diện với mọi đối thủ.',
    icon: '🔄',
    badge: 'Toàn diện',
  },
  {
    id: 'ELO_ARENA',
    name: 'Đấu trường Elo',
    desc: 'Sàn đấu ghép cặp liên tục dựa trên điểm kỹ năng và bậc xếp hạng toàn cầu.',
    icon: '🏆',
    badge: 'Xếp hạng',
  },
];

export default async function HomePage() {
  const [tournaments, ratings] = await Promise.all([
    listTournaments(),
    getGlobalTeamLeaderboard({ limit: 8 }),
  ]);

  const runningTournament = tournaments.find(t => t.state === 'RUNNING') ?? tournaments[0] ?? null;

  return (
    <div className="space-y-12">
      {/* 1. Live Ticker / Active Spotlight Banner */}
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
                <span className="text-xs text-[var(--text-faint)]">·</span>
                <span className="text-xs text-[var(--text-secondary)] font-medium">
                  {formatLabel[runningTournament.format] ?? runningTournament.format}
                </span>
              </div>

              <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-[var(--text-primary)] truncate">
                {runningTournament.name}
              </h2>

              <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-[var(--text-secondary)]">
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

      {/* 2. Main Hero Stage */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-center pt-2 pb-4">
        {/* Left Column: Heading & Value Prop */}
        <div className="lg:col-span-7 space-y-6">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-subtle)] text-xs text-[var(--text-secondary)] shadow-xs">
            <span className="w-2 h-2 rounded-full bg-[var(--action)]" />
            <span className="font-semibold text-[var(--text-primary)]">Đấu trường trí tuệ nhân tạo</span>
            <span>·</span>
            <span>Mùa giải 2026</span>
          </div>

          <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight text-[var(--text-primary)] leading-[1.12]">
            Đấu trường Bot thuật toán Búa · Kéo · Bao
          </h1>

          <p className="text-base text-[var(--text-secondary)] leading-relaxed max-w-xl">
            Nền tảng thi đấu thuật toán đối kháng thời gian thực trên bàn cờ lưới. Lập trình bot bằng Python, TypeScript hoặc C++20, chinh phục bàn đấu và khẳng định thứ hạng đội tuyển.
          </p>

          <div className="flex flex-wrap items-center gap-3.5 pt-2">
            <Link href="/tournaments" className="vct-btn-primary !py-3 !px-6 !text-sm !rounded-full">
              Khám phá các giải đấu →
            </Link>
            <Link href="/workspace" className="vct-btn-secondary !py-3 !px-6 !text-sm !rounded-full">
              Không gian đội
            </Link>
          </div>

          <div className="pt-6 border-t border-[var(--border-subtle)] grid grid-cols-3 gap-6 max-w-lg">
            <div>
              <div className="font-heading text-2xl font-bold text-[var(--text-primary)]">
                {tournaments.length}
              </div>
              <div className="text-xs text-[var(--text-secondary)] mt-0.5">
                Giải đấu công bố
              </div>
            </div>
            <div>
              <div className="font-heading text-2xl font-bold text-[var(--live-accent)]">
                {tournaments.filter(t => t.state === 'RUNNING').length}
              </div>
              <div className="text-xs text-[var(--text-secondary)] mt-0.5">
                Đang trực tiếp
              </div>
            </div>
            <div>
              <div className="font-heading text-2xl font-bold text-[var(--text-primary)]">
                3
              </div>
              <div className="text-xs text-[var(--text-secondary)] mt-0.5">
                Ngôn ngữ (Py, TS, C++)
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Interactive Trinity Battle Wheel */}
        <div className="lg:col-span-5 flex justify-center">
          <TrinityBattleWheel />
        </div>
      </section>

      {/* 3. Competitive Formats Grid */}
      <section className="space-y-6 pt-4">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
          <div>
            <h2 className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">
              Thể thức thi đấu
            </h2>
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              Bốn mô hình thi đấu đối kháng chuẩn mực đáp ứng mọi quy mô giải đấu.
            </p>
          </div>
          <Link
            href="/tournaments"
            className="text-xs font-semibold text-[var(--action)] hover:underline inline-flex items-center gap-1"
          >
            Xem tất cả giải đấu theo thể thức →
          </Link>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {MODES.map(mode => (
            <Link
              key={mode.id}
              href="/tournaments"
              className="group relative flex flex-col justify-between rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-5 shadow-sm hover:border-[var(--action)]/50 hover:shadow-md transition-all hover:-translate-y-1"
            >
              <div>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-2xl">{mode.icon}</span>
                  <span className="text-[10px] font-mono font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-subtle)] text-[var(--text-secondary)]">
                    {mode.badge}
                  </span>
                </div>
                <h3 className="text-base font-bold text-[var(--text-primary)] group-hover:text-[var(--action)] transition-colors">
                  {mode.name}
                </h3>
                <p className="mt-2 text-xs text-[var(--text-secondary)] leading-relaxed">
                  {mode.desc}
                </p>
              </div>

              <div className="mt-4 pt-3 border-t border-[var(--border-subtle)] text-right">
                <span className="text-xs font-semibold text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] transition-colors">
                  Khám phá →
                </span>
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* 4. Leaderboard & Quick Action Hub */}
      <section className="grid grid-cols-1 lg:grid-cols-[1.1fr_0.9fr] gap-8 items-start pt-4">
        {/* Left: Featured Rankings */}
        <div className="space-y-4">
          <FeaturedRanking leaderboard={ratings.kind === 'success' ? ratings.data : null} />
        </div>

        {/* Right: Quick Action Hub & Workflow */}
        <div className="space-y-6">
          {/* Quick Hub Card */}
          <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-6 shadow-sm space-y-4">
            <h3 className="text-lg font-bold text-[var(--text-primary)]">
              Quy trình thi đấu
            </h3>
            <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
              Mỗi đội gồm 2 thành viên cùng phát triển thuật toán. Bạn có thể tự do thử nghiệm mã nguồn trước khi chính thức nộp vào giải đấu.
            </p>

            <ol className="space-y-3.5 text-xs text-[var(--text-secondary)] pt-2">
              <li className="flex items-start gap-3">
                <span className="flex items-center justify-center w-5 h-5 rounded-full bg-[var(--surface-subtle)] border border-[var(--border-subtle)] text-[var(--text-primary)] font-bold text-[10px] shrink-0 mt-0.5">
                  1
                </span>
                <div>
                  <strong className="text-[var(--text-primary)]">Viết mã nguồn Bot:</strong> Sử dụng SDK mẫu trong thư mục <code className="font-mono text-[var(--accent-secondary)]">sdk/</code> bằng Python, TypeScript hoặc C++.
                </div>
              </li>
              <li className="flex items-start gap-3">
                <span className="flex items-center justify-center w-5 h-5 rounded-full bg-[var(--surface-subtle)] border border-[var(--border-subtle)] text-[var(--text-primary)] font-bold text-[10px] shrink-0 mt-0.5">
                  2
                </span>
                <div>
                  <strong className="text-[var(--text-primary)]">Chạy thử nghiệm (Private Test):</strong> Soạn thảo trên Monaco IDE hoặc tải file <code className="font-mono text-[var(--accent-secondary)]">.zip</code> để test nội bộ không ảnh hưởng điểm số.
                </div>
              </li>
              <li className="flex items-start gap-3">
                <span className="flex items-center justify-center w-5 h-5 rounded-full bg-[var(--surface-subtle)] border border-[var(--border-subtle)] text-[var(--text-primary)] font-bold text-[10px] shrink-0 mt-0.5">
                  3
                </span>
                <div>
                  <strong className="text-[var(--text-primary)]">Tham gia thi đấu:</strong> Đăng ký vào giải đấu đang mở, theo dõi trực tiếp lượt đi trên Live HUD và xem lại Replay bàn cờ.
                </div>
              </li>
            </ol>

            <div className="pt-2">
              <Link
                href="/workspace"
                className="vct-btn-primary !w-full !py-2.5 !text-xs !rounded-full block text-center"
              >
                Vào Không gian đội →
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
