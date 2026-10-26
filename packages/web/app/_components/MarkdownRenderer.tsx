'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { copyText } from '../../lib/clipboard';

export interface MarkdownBlock {
  type: 'code' | 'heading' | 'blockquote' | 'ul' | 'ol' | 'hr' | 'paragraph';
  level?: 1 | 2 | 3 | 4 | 5 | 6;
  language?: string;
  content?: string;
  text?: string;
  lines?: string[];
  items?: string[];
}

export function normalizeMarkdownText(raw: string): string {
  if (!raw) return '';
  let text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Handle literal escaped \n and \t strings from database/JSON
  if (text.includes('\\n')) {
    text = text.replace(/\\n/g, '\n');
  }
  if (text.includes('\\t')) {
    text = text.replace(/\\t/g, '\t');
  }
  return text;
}

export function parseMarkdownBlocks(raw: string): MarkdownBlock[] {
  const normalized = normalizeMarkdownText(raw);
  const lines = normalized.split('\n');
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 1. Fenced code block (```lang ... ```)
    if (line.trim().startsWith('```')) {
      const language = line.trim().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length && lines[i].trim().startsWith('```')) {
        i++; // consume closing fence
      }
      blocks.push({
        type: 'code',
        language: language || undefined,
        content: codeLines.join('\n'),
      });
      continue;
    }

    // 2. Empty line
    if (line.trim() === '') {
      i++;
      continue;
    }

    // 3. Horizontal rule (---, ***, ___)
    if (/^(?:---|\*\*\*|___)\s*$/.test(line.trim())) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // 4. Headings (# H1, ## H2, ### H3, etc.)
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        text: headingMatch[2].trim(),
      });
      i++;
      continue;
    }

    // 5. Blockquotes (> quote)
    if (line.trim().startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'blockquote', lines: quoteLines });
      continue;
    }

    // 6. Bullet lists (- item or * item)
    if (/^[-*]\s+/.test(line.trim())) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }

    // 7. Numbered lists (1. item)
    if (/^\d+\.\s+/.test(line.trim())) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }

    // 8. Paragraph
    const pLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== '') {
      const cur = lines[i];
      if (
        cur.trim().startsWith('```') ||
        /^(#{1,6})\s+/.test(cur) ||
        /^(?:---|\*\*\*|___)\s*$/.test(cur.trim()) ||
        cur.trim().startsWith('>') ||
        /^[-*]\s+/.test(cur.trim()) ||
        /^\d+\.\s+/.test(cur.trim())
      ) {
        break;
      }
      pLines.push(cur);
      i++;
    }
    if (pLines.length > 0) {
      blocks.push({ type: 'paragraph', lines: pLines });
    }
  }

  return blocks;
}

function parseInlineTokens(text: string): React.ReactNode[] {
  if (!text) return [];

  // Regex matching inline code, bold (** or __), italic (* or _), links [text](url)
  const tokenRegex = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|\[[^\]\n]+\]\((?:https?:\/\/[^\s)]+|\/[^\s)]+|#[^\s)]+)\))/g;

  const parts = text.split(tokenRegex);
  return parts.map((part, index) => {
    if (!part) return null;

    // Inline code: `code`
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      const codeText = part.slice(1, -1);
      return (
        <code
          key={index}
          className="font-mono text-[12px] sm:text-[13px] px-1.5 py-0.5 rounded-md bg-[var(--surface-subtle)] text-[var(--action)] border border-[var(--border-subtle)] font-medium"
        >
          {codeText}
        </code>
      );
    }

    // Bold: **text** or __text__
    if (
      (part.startsWith('**') && part.endsWith('**') && part.length >= 4) ||
      (part.startsWith('__') && part.endsWith('__') && part.length >= 4)
    ) {
      const boldText = part.slice(2, -2);
      return (
        <strong key={index} className="font-bold text-[var(--text-primary)]">
          {parseInlineTokens(boldText)}
        </strong>
      );
    }

    // Italic: *text* or _text_
    if (
      (part.startsWith('*') && part.endsWith('*') && part.length >= 2) ||
      (part.startsWith('_') && part.endsWith('_') && part.length >= 2)
    ) {
      const italicText = part.slice(1, -1);
      return (
        <em key={index} className="italic text-[var(--text-secondary)]">
          {parseInlineTokens(italicText)}
        </em>
      );
    }

    // Link: [text](url)
    const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      const [, linkText, linkUrl] = linkMatch;
      const isInternal = linkUrl.startsWith('/') || linkUrl.startsWith('#');
      if (isInternal) {
        return (
          <Link
            key={index}
            href={linkUrl}
            className="text-[var(--action)] font-medium hover:underline transition-colors"
          >
            {parseInlineTokens(linkText)}
          </Link>
        );
      }
      return (
        <a
          key={index}
          href={linkUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--action)] font-medium hover:underline transition-colors inline-flex items-center gap-0.5"
        >
          {parseInlineTokens(linkText)}
          <span className="text-[10px] opacity-70">↗</span>
        </a>
      );
    }

    return <span key={index}>{part}</span>;
  });
}

function CodeBlockView({ language, code }: { language?: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  const handleCopy = () => {
    void copyText(code).then((confirmed) => {
      setCopied(confirmed);
      setFailed(!confirmed);
    });
  };

  return (
    <div className="my-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)] overflow-hidden shadow-xs">
      <div className="flex items-center justify-between px-3.5 py-1.5 bg-[var(--surface-accent)]/40 border-b border-[var(--border-subtle)] text-[11px] font-mono text-[var(--text-secondary)]">
        <span className="font-bold uppercase tracking-wider text-[var(--text-faint)]">
          {language || 'code'}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="hover:text-[var(--text-primary)] transition-colors px-2 py-0.5 rounded text-[10px] font-mono border border-[var(--border-subtle)] bg-[var(--surface)] active:scale-95 cursor-pointer"
          title={failed && !copied ? 'Trình duyệt không cho phép tự sao chép — hãy chọn mã và copy thủ công.' : 'Sao chép khối mã'}
        >
          {copied ? '✓ Đã chép' : failed && !copied ? 'Chép tay' : 'Sao chép'}
        </button>
      </div>
      <pre className="p-4 overflow-x-auto text-xs sm:text-[13px] font-mono leading-relaxed text-[var(--text-primary)]">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export interface MarkdownRendererProps {
  content: string;
  className?: string;
  maxBlocks?: number;
}

export default function MarkdownRenderer({
  content,
  className = '',
  maxBlocks,
}: MarkdownRendererProps) {
  if (!content) return null;

  const allBlocks = parseMarkdownBlocks(content);
  const blocks = typeof maxBlocks === 'number' && maxBlocks > 0
    ? allBlocks.slice(0, maxBlocks)
    : allBlocks;

  return (
    <div className={`space-y-3 font-normal text-[var(--text-primary)] ${className}`}>
      {blocks.map((block, idx) => {
        switch (block.type) {
          case 'code':
            return (
              <CodeBlockView
                key={idx}
                language={block.language}
                code={block.content ?? ''}
              />
            );

          case 'heading': {
            const textNodes = parseInlineTokens(block.text ?? '');
            switch (block.level) {
              case 1:
                return (
                  <h1
                    key={idx}
                    className="text-2xl sm:text-3xl font-extrabold tracking-tight text-[var(--text-primary)] mt-6 mb-3 pb-2 border-b border-[var(--border-subtle)]"
                  >
                    {textNodes}
                  </h1>
                );
              case 2:
                return (
                  <h2
                    key={idx}
                    className="text-xl sm:text-2xl font-bold tracking-tight text-[var(--text-primary)] mt-5 mb-2.5 flex items-center gap-2.5"
                  >
                    <span className="w-1.5 h-5 rounded-full bg-[var(--action)] inline-block shrink-0" />
                    <span>{textNodes}</span>
                  </h2>
                );
              case 3:
                return (
                  <h3
                    key={idx}
                    className="text-base sm:text-lg font-bold text-[var(--text-primary)] mt-4 mb-2 flex items-center gap-2"
                  >
                    <span className="w-1 h-3.5 rounded-full bg-[var(--text-faint)] inline-block shrink-0" />
                    <span>{textNodes}</span>
                  </h3>
                );
              case 4:
              default:
                return (
                  <h4
                    key={idx}
                    className="text-sm sm:text-base font-bold text-[var(--text-primary)] mt-3 mb-1.5"
                  >
                    {textNodes}
                  </h4>
                );
            }
          }

          case 'blockquote':
            return (
              <blockquote
                key={idx}
                className="border-l-4 border-[var(--action)] bg-[var(--surface-subtle)]/60 px-4 py-3 rounded-r-xl my-3 text-sm text-[var(--text-secondary)] italic leading-relaxed space-y-1"
              >
                {block.lines?.map((line, qIdx) => (
                  <p key={qIdx}>{parseInlineTokens(line)}</p>
                ))}
              </blockquote>
            );

          case 'ul':
            return (
              <ul
                key={idx}
                className="space-y-1.5 my-3 pl-5 list-disc text-sm sm:text-[14.5px] text-[var(--text-primary)] marker:text-[var(--action)] leading-relaxed"
              >
                {block.items?.map((item, uIdx) => (
                  <li key={uIdx}>{parseInlineTokens(item)}</li>
                ))}
              </ul>
            );

          case 'ol':
            return (
              <ol
                key={idx}
                className="space-y-1.5 my-3 pl-5 list-decimal text-sm sm:text-[14.5px] text-[var(--text-primary)] marker:font-mono marker:font-bold marker:text-[var(--action)] leading-relaxed"
              >
                {block.items?.map((item, oIdx) => (
                  <li key={oIdx}>{parseInlineTokens(item)}</li>
                ))}
              </ol>
            );

          case 'hr':
            return (
              <hr
                key={idx}
                className="my-5 border-0 h-px bg-[var(--border-subtle)]"
              />
            );

          case 'paragraph':
          default:
            return (
              <p
                key={idx}
                className="text-sm sm:text-[15px] text-[var(--text-primary)] leading-relaxed my-2.5"
              >
                {block.lines?.map((line, lIdx) => (
                  <React.Fragment key={lIdx}>
                    {lIdx > 0 && <span className="inline"> </span>}
                    {parseInlineTokens(line)}
                  </React.Fragment>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
}
