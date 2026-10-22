'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import type { NewsPostDto } from '../../lib/api';
import MarkdownRenderer, { parseMarkdownBlocks } from './MarkdownRenderer';

function formatUtcInstant(iso: string | null | undefined): string {
  if (!iso) return '—';
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(iso);
  return match ? `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]} UTC` : iso;
}

function CopyLinkButton({ slug }: { slug: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (typeof window !== 'undefined' && navigator.clipboard) {
      const url = `${window.location.origin}/news/${encodeURIComponent(slug)}`;
      navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-subtle)] text-[11px] font-mono text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-control)] transition-all cursor-pointer active:scale-95"
      title="Sao chép liên kết bài viết"
    >
      <svg className="w-3.5 h-3.5 text-current" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
      </svg>
      <span>{copied ? '✓ Đã chép link' : 'Chia sẻ'}</span>
    </button>
  );
}

export interface NewsSectionProps {
  readonly posts?: readonly NewsPostDto[] | null;
  readonly className?: string;
}

export default function NewsSection({ posts = [], className = '' }: NewsSectionProps) {
  const list = posts ?? [];

  return (
    <section aria-label="Bản tin và thông báo chính thức" className={`space-y-6 ${className}`}>
      {/* Feed Header */}
      <div className="flex items-center justify-between pb-3 border-b border-[var(--border-subtle)]">
        <div className="flex items-center gap-3">
          <div className="w-2.5 h-2.5 rounded-full bg-[var(--action)] animate-pulse" />
          <h2 className="text-xl font-extrabold tracking-tight text-[var(--text-primary)]">
            Bản tin & Thông báo chính thức
          </h2>
        </div>
        <span className="text-xs font-mono text-[var(--text-secondary)]">
          Codeforces-style Feed
        </span>
      </div>

      {list.length === 0 ? (
        <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-10 text-center space-y-3">
          <div className="w-12 h-12 rounded-full bg-[var(--surface-subtle)] text-[var(--text-faint)] flex items-center justify-center mx-auto text-lg font-mono">
            📰
          </div>
          <h3 className="font-bold text-base text-[var(--text-primary)]">
            Chưa có bản tin mới từ Ban tổ chức
          </h3>
          <p className="text-xs text-[var(--text-secondary)] max-w-md mx-auto leading-relaxed">
            Các thông báo điều hành giải đấu, hướng dẫn lập trình bot và cập nhật hệ thống mới nhất sẽ được đăng tải trực tiếp tại đây.
          </p>
        </div>
      ) : (
        <div className="space-y-6 sm:space-y-8">
          {list.map((post, idx) => {
            const authorName =
              'authorDisplayName' in post && typeof post.authorDisplayName === 'string'
                ? post.authorDisplayName
                : 'Ban tổ chức';
            const publishedDate = post.publishedAt ?? post.createdAt;
            const blocks = parseMarkdownBlocks(post.content);
            const isLongPost = blocks.length > 4 || post.content.length > 600;

            return (
              <article
                key={post.id}
                className="group relative rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-6 sm:p-7 shadow-xs hover:border-[var(--border-control)] transition-all space-y-5"
              >
                {/* 1. Header: Meta info line */}
                <header className="space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2 font-mono text-[11.5px] text-[var(--text-secondary)]">
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

                    {idx === 0 ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-mono font-bold text-[var(--action)] bg-[var(--action)]/10 px-2.5 py-0.5 rounded-full">
                        <span className="w-1.5 h-1.5 rounded-full bg-[var(--action)] animate-ping" />
                        MỚI NHẤT
                      </span>
                    ) : null}
                  </div>

                  {/* 2. Title */}
                  <h3 className="text-xl sm:text-2xl font-bold tracking-tight text-[var(--text-primary)] group-hover:text-[var(--action)] transition-colors leading-snug">
                    <Link
                      href={`/news/${encodeURIComponent(post.slug)}`}
                      className="hover:underline focus:outline-hidden"
                    >
                      {post.title}
                    </Link>
                  </h3>
                </header>

                {/* 3. Summary lead callout box */}
                {post.summary ? (
                  <div className="rounded-xl border-l-4 border-[var(--action)] bg-[var(--surface-subtle)] p-4 text-sm text-[var(--text-secondary)] leading-relaxed shadow-2xs">
                    <div className="font-semibold text-[10.5px] uppercase tracking-wider text-[var(--text-faint)] mb-1 font-mono">
                      Tóm tắt nội dung
                    </div>
                    <p className="text-[var(--text-primary)] font-medium text-sm sm:text-[14.5px]">
                      {post.summary}
                    </p>
                  </div>
                ) : null}

                {/* 4. Body: Markdown Content preview */}
                <div className="border-t border-[var(--border-subtle)]/60 pt-4">
                  <MarkdownRenderer
                    content={post.content}
                    maxBlocks={4}
                  />

                  {isLongPost ? (
                    <div className="mt-4 pt-3 border-t border-dashed border-[var(--border-subtle)] flex items-center justify-between">
                      <Link
                        href={`/news/${encodeURIComponent(post.slug)}`}
                        className="inline-flex items-center gap-1.5 text-sm font-bold text-[var(--action)] hover:underline group-hover:translate-x-0.5 transition-transform"
                      >
                        <span>Xem toàn bộ bài viết & thảo luận</span>
                        <span>→</span>
                      </Link>
                      <span className="text-xs font-mono text-[var(--text-faint)]">
                        Còn tiếp...
                      </span>
                    </div>
                  ) : null}
                </div>

                {/* 5. Footer: Actions & Metadata */}
                <footer className="pt-4 border-t border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-3 text-xs">
                  <div className="flex items-center gap-2.5">
                    <Link
                      href={`/news/${encodeURIComponent(post.slug)}`}
                      className="vct-btn-secondary !py-1.5 !px-3.5 !text-xs !rounded-lg inline-flex items-center gap-1.5 font-mono shadow-2xs"
                    >
                      Chi tiết bài viết →
                    </Link>
                    <CopyLinkButton slug={post.slug} />
                  </div>

                  <div className="flex items-center gap-2 text-[11px] font-mono text-[var(--text-faint)]">
                    <span>OanTuTi Arena</span>
                    <span>·</span>
                    <Link
                      href={`/news/${encodeURIComponent(post.slug)}`}
                      className="hover:text-[var(--text-primary)] transition-colors"
                    >
                      Thảo luận
                    </Link>
                  </div>
                </footer>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
