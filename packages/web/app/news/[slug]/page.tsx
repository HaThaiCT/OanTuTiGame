import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ApiResult } from '../../../lib/client';
import type { NewsPostDto } from '../../../lib/api';
import { getNewsPost } from '../../../lib/api';
import MarkdownRenderer from '../../_components/MarkdownRenderer';

export const dynamic = 'force-dynamic';

function formatUtcInstant(iso: string | null | undefined): string {
  if (!iso) return '—';
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(iso);
  return match ? `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]} UTC` : iso;
}

/**
 * A transport failure (`ok: false`) must not be conflated with an unpublished/deleted slug:
 * an outage during the API hiccup renders an explicit retryable notice, while a request that
 * completed but carries no post still serves the shared 404.
 */
export function classifyNewsFetch(result: ApiResult<{ post: NewsPostDto } | null>): 'transport-refusal' | 'missing' | 'present' {
  if (!result.ok) return 'transport-refusal';
  return result.data?.post ? 'present' : 'missing';
}

export default async function NewsDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const result = await getNewsPost(slug);

  if (classifyNewsFetch(result) === 'transport-refusal') {
    return (
      <section role="alert" className="mx-auto max-w-3xl space-y-3 rounded-2xl border border-[var(--warning-text)] bg-[var(--surface)] p-6 text-sm">
        <h1 className="text-lg font-semibold text-[var(--text-primary)]">Không tải được bản tin</h1>
        <p className="text-[var(--text-secondary)]">
          Máy chủ thông báo tạm thời không phản hồi cho bài viết này. Hãy thử tải lại trang.
          {result.message ? ` (${result.message})` : null}
        </p>
        <Link href="/#news" className="inline-block underline text-[var(--action)]">← Về danh sách bản tin</Link>
      </section>
    );
  }

  if (classifyNewsFetch(result) === 'missing' || !result.data?.post) {
    notFound();
  }

  const post = result.data.post;
  const authorName =
    'authorDisplayName' in post && typeof post.authorDisplayName === 'string'
      ? post.authorDisplayName
      : 'Ban tổ chức';
  const publishedDate = post.publishedAt ?? post.createdAt;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Breadcrumb Navigation */}
      <nav aria-label="Đường dẫn điều hướng" className="flex items-center gap-2 text-xs text-[var(--text-secondary)] font-mono flex-wrap">
        <Link href="/" className="hover:text-[var(--text-primary)] transition-colors">
          Trang chủ
        </Link>
        <span>/</span>
        <Link href="/#news" className="hover:text-[var(--text-primary)] transition-colors">
          Bản tin
        </Link>
        <span>/</span>
        <span className="text-[var(--text-primary)] font-medium truncate max-w-xs sm:max-w-md">
          {post.title}
        </span>
      </nav>

      {/* Main Article Container */}
      <article className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-6 sm:p-9 shadow-xs space-y-6">
        {/* Header Section */}
        <header className="space-y-4 border-b border-[var(--border-subtle)] pb-6">
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex flex-wrap items-center gap-2.5 font-mono text-[11.5px] text-[var(--text-secondary)]">
              <span className="inline-flex items-center gap-1.5 font-semibold text-[var(--text-primary)]">
                <span className="w-5 h-5 rounded-full bg-[var(--action)]/15 text-[var(--action)] flex items-center justify-center text-[10px] font-bold">
                  O
                </span>
                Đăng bởi {authorName}
              </span>
              <span className="text-[var(--text-faint)]">·</span>
              <time dateTime={publishedDate} className="text-[var(--text-secondary)]">
                {formatUtcInstant(publishedDate)}
              </time>
              <span className="text-[var(--text-faint)]">·</span>
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-[var(--surface-subtle)] text-[var(--action)] border border-[var(--border-subtle)] uppercase tracking-wider">
                BẢN TIN
              </span>
            </div>

            <div className="text-xs font-mono text-[var(--text-faint)]">
              OanTuTi Arena Official
            </div>
          </div>

          <h1 className="text-2xl sm:text-3xl lg:text-4xl font-extrabold tracking-tight text-[var(--text-primary)] leading-tight">
            {post.title}
          </h1>

          {/* Summary Callout Box */}
          {post.summary ? (
            <div className="rounded-xl border-l-4 border-[var(--action)] bg-[var(--surface-subtle)] p-4 sm:p-5 text-sm sm:text-[14.5px] text-[var(--text-secondary)] leading-relaxed shadow-2xs">
              <div className="font-semibold text-[10.5px] uppercase tracking-wider text-[var(--text-faint)] mb-1 font-mono">
                Tóm tắt nội dung
              </div>
              <p className="text-[var(--text-primary)] font-medium">
                {post.summary}
              </p>
            </div>
          ) : null}
        </header>

        {/* Content Body with MarkdownRenderer */}
        <div className="py-2">
          <MarkdownRenderer content={post.content} />
        </div>

        {/* Footer Actions */}
        <footer className="pt-6 border-t border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-4">
          <Link
            href="/"
            className="vct-btn-secondary !py-2 !px-4 !text-xs !rounded-lg inline-flex items-center gap-1.5 font-mono shadow-xs"
          >
            ← Quay lại trang chủ
          </Link>
          <div className="flex items-center gap-3 text-xs font-mono text-[var(--text-faint)]">
            <span>Bài viết chính thức</span>
            <span>·</span>
            <span className="text-[var(--text-secondary)]">OanTuTi Arena</span>
          </div>
        </footer>
      </article>
    </div>
  );
}
