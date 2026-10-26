import { describe, expect, it } from 'vitest';
import { newsPostIsTruncated } from './NewsSection';
import { parseMarkdownBlocks } from './MarkdownRenderer';

describe('newsPostIsTruncated', () => {
  it('truncates posts with more blocks than the 4-block preview cap', () => {
    expect(newsPostIsTruncated(parseMarkdownBlocks(''))).toBe(false);
    expect(newsPostIsTruncated(parseMarkdownBlocks('A\n\nB\n\nC\n\nD'))).toBe(false);
    expect(newsPostIsTruncated(parseMarkdownBlocks('A\n\nB\n\nC\n\nD\n\nE'))).toBe(true);
  });

  it('no longer fabricates "Còn tiếp..." for a fully rendered post longer than 600 characters', () => {
    // One single 650-character paragraph block: renders completely at maxBlocks={4}.
    const post = 'M'.repeat(650);
    const blocks = parseMarkdownBlocks(post);
    expect(post.length).toBeGreaterThan(600);
    expect(blocks.length).toBeLessThanOrEqual(4);
    // Regression: the old `blocks.length > 4 || post.content.length > 600` predicate claimed a
    // partial preview for this post although all of it renders.
    expect(newsPostIsTruncated(blocks)).toBe(false);
  });

  it('still truncates block-heavy posts that the preview really cuts off', () => {
    const blocks = parseMarkdownBlocks('A\n\nB\n\nC\n\nD\n\n- x\n- y\n- z\n');
    expect(newsPostIsTruncated(blocks)).toBe(true);
  });
});
