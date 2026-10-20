import type { Announcement } from '../../../lib/api';
import { announcementTopicLabel } from '../../../lib/labels';

export interface AnnouncementsSectionProps {
  /** `null` = the announcements feed could not be read; `[]` = the server has no events yet. */
  readonly announcements: readonly Announcement[] | null;
}

/**
 * The feed exposes exactly these outbox topics
 * (`GET /api/v2/tournaments/:id/announcements`, server allow-list). Anything else still renders
 * through the generic fallback, but no summary is written for a topic the server never emits.
 */
const KNOWN_TOPICS: Record<string, true> = {
  TOURNAMENT_PUBLISHED: true,
  REGISTRATION_OPENED: true,
  REGISTRATION_CLOSED: true,
  TOURNAMENT_LOCKED: true,
  TOURNAMENT_STARTED: true,
  TOURNAMENT_PAUSED: true,
  TOURNAMENT_RESUMED: true,
  ROUND_SCHEDULED: true,
  TOURNAMENT_PROVISIONAL: true,
  TOURNAMENT_FINALIZED: true,
};

/** Payload keys have shipped both camelCase and snake_case, so each lookup tries both. */
function pick(payload: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const found = payload[key];
    if (found !== undefined && found !== null && found !== '') return found;
  }
  return null;
}

function text(payload: Record<string, unknown>, ...keys: string[]): string | null {
  const found = pick(payload, ...keys);
  return typeof found === 'string' || typeof found === 'number' || typeof found === 'boolean'
    ? String(found)
    : null;
}

function count(payload: Record<string, unknown>, ...keys: string[]): number | null {
  const found = pick(payload, ...keys);
  const parsed = typeof found === 'number' ? found : Number(found ?? NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

/** `2026-10-17T08:31:12.123Z` → `2026-10-17 08:31 UTC`; the API stores UTC instants. */
function instant(value: string | null): string {
  if (!value) return '—';
  return `${value.slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * Short Vietnamese summary of an `outbox_events.payload`. The payload is never dumped as JSON:
 * known topics render from their own fields, and anything else falls back to a few `key: value`
 * scalars so a new server topic still shows something readable.
 */
export function summarizeAnnouncement(topic: string, payload: Record<string, unknown> | null): string {
  if (!payload) return 'Không có chi tiết kèm theo.';
  switch (topic) {
    case 'TOURNAMENT_PUBLISHED':
      return 'Giải đã được công bố công khai.';
    case 'REGISTRATION_OPENED': {
      const closesAt = text(payload, 'registrationClosesAt', 'registration_closes_at');
      return closesAt
        ? `Đăng ký đã mở · hạn đăng ký ${instant(closesAt)}.`
        : 'Đăng ký đã mở cho các đội.';
    }
    case 'REGISTRATION_CLOSED':
      return 'Đăng ký đã đóng — ban tổ chức không nhận thêm đội mới.';
    case 'TOURNAMENT_LOCKED': {
      const eligible = count(payload, 'eligibleTeamsCount', 'eligible_teams_count');
      const excluded = count(payload, 'excludedTeamsCount', 'excluded_teams_count');
      const parts = [
        eligible === null ? null : `${eligible} đội đủ điều kiện`,
        excluded === null ? null : `${excluded} đội bị loại`,
      ].filter((part): part is string => part !== null);
      return parts.length === 0 ? 'Danh sách đội đã được khóa.' : `Danh sách khóa: ${parts.join(', ')}.`;
    }
    case 'TOURNAMENT_STARTED': {
      const eligible = count(payload, 'eligibleTeamsCount', 'eligible_teams_count');
      return eligible === null ? 'Giải đã bắt đầu.' : `Giải đã bắt đầu với ${eligible} đội.`;
    }
    case 'TOURNAMENT_PAUSED':
      return 'Giải đang tạm dừng theo lệnh ban tổ chức.';
    case 'TOURNAMENT_RESUMED':
      return 'Giải đã tiếp tục.';
    case 'ROUND_SCHEDULED': {
      const stage = text(payload, 'stage');
      const round = count(payload, 'roundOrdinal', 'round_ordinal');
      const pairings = count(payload, 'pairingsCount', 'pairings_count');
      const parts = [
        stage ? `stage ${stage}` : null,
        round === null ? null : `vòng ${round}`,
        pairings === null ? null : `${pairings} cặp đấu`,
      ].filter((part): part is string => part !== null);
      return parts.length === 0 ? 'Đã xếp lịch vòng đấu mới.' : `Đã xếp lịch: ${parts.join(' · ')}.`;
    }
    case 'TOURNAMENT_PROVISIONAL': {
      const stage = text(payload, 'stage');
      return `Đã đấu xong${stage ? ` stage ${stage}` : ''} — kết quả đang ở trạng thái tạm tính, chờ xử lý tranh chấp và kháng nghị.`;
    }
    case 'TOURNAMENT_FINALIZED': {
      const finalizedAt = text(payload, 'finalizedAt', 'finalized_at');
      return `Đã chốt kết quả chính thức${finalizedAt ? ` lúc ${instant(finalizedAt)}` : ''}.`;
    }
    default: {
      const entries = Object.entries(payload)
        .filter(([, entry]) => typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean')
        .slice(0, 4)
        .map(([key, entry]) => `${key}: ${String(entry)}`);
      if (entries.length === 0) return 'Không có chi tiết kèm theo.';
      return entries.join(' · ');
    }
  }
}

export default function AnnouncementsSection({ announcements }: AnnouncementsSectionProps) {
  return (
    <section className="min-w-0 overflow-hidden border border-[var(--border-subtle)] bg-[var(--surface)] rounded-2xl shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-5 py-4">
        <div>
          <h2 className="font-heading text-base font-bold text-[var(--text-primary)]">
            Thông báo giải đấu
          </h2>
          <p className="text-xs text-[var(--text-secondary)]">
            Dòng thời gian sự kiện: lịch đấu, chốt danh sách và kết quả
          </p>
        </div>
        <span className="font-mono text-xs text-[var(--text-secondary)] border border-[var(--border-subtle)] px-2.5 py-1 rounded-full">
          {announcements === null ? 'Lỗi dữ liệu' : `${announcements.length} thông báo`}
        </span>
      </div>

      {announcements === null ? (
        <p className="px-6 py-10 text-center text-xs text-[var(--text-secondary)]">
          Không thể đọc thông báo từ máy chủ. Vui lòng tải lại trang.
        </p>
      ) : announcements.length === 0 ? (
        <p className="px-6 py-10 text-center text-xs text-[var(--text-secondary)]">
          Chưa có thông báo nào cho giải đấu này.
        </p>
      ) : (
        <ol className="flex flex-col">
          {announcements.map((announcement) => (
            <li
              key={announcement.id}
              className="flex flex-col gap-1 border-b border-[var(--border-subtle)] border-l-2 border-l-[var(--action)] px-4 py-3.5 last:border-b-0 hover:bg-[var(--surface-subtle)] transition-colors sm:flex-row sm:items-start sm:gap-4"
            >
              <time
                className="w-full shrink-0 font-mono text-xs tabular-nums text-[var(--text-secondary)] sm:w-44"
                dateTime={announcement.createdAt ?? undefined}
              >
                [{instant(announcement.createdAt)}]
              </time>
              <div className="min-w-0">
                <p className="font-heading text-sm font-bold uppercase tracking-wider text-[var(--text-primary)]">
                  {announcementTopicLabel[announcement.topic] ?? announcement.topic}
                  {KNOWN_TOPICS[announcement.topic] === true ? null : (
                    <span className="ml-2 border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-secondary)]">
                      {announcement.topic}
                    </span>
                  )}
                </p>
                <p className="mt-1 break-words font-body text-xs text-[var(--text-secondary)]">
                  {summarizeAnnouncement(announcement.topic, announcement.payload)}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
