import { describe, expect, it } from 'vitest';
import type { ApiResult } from '../../../lib/client';
import type { NewsPostDto } from '../../../lib/api';
import { classifyNewsFetch } from './page';

function result(overrides: Partial<ApiResult<{ post: NewsPostDto }>>): ApiResult<{ post: NewsPostDto }> {
  return { ok: true, status: 200, data: null, message: null, ...overrides };
}

describe('classifyNewsFetch', () => {
  it('serves the retryable outage notice for transport failures instead of the shared 404', () => {
    // Regression: the old `if (!result.ok || !result.data?.post) notFound()` served the plain
    // unbranded 404 for an API outage, hiding a missing post behind a missing server.
    expect(classifyNewsFetch(result({ ok: false, status: 0, message: 'Không kết nối được API.' }))).toBe('transport-refusal');
    expect(classifyNewsFetch(result({ ok: false, status: 502, message: 'Bad gateway' }))).toBe('transport-refusal');
  });

  it('keeps the shared 404 for a completed request that carries no post', () => {
    expect(classifyNewsFetch(result({}))).toBe('missing');
    expect(classifyNewsFetch(result({ data: null, status: 404, message: 'Not found' }))).toBe('missing');
  });

  it('marks a completed fetch with a post as present', () => {
    const post = { id: 'p1', slug: 'p1' } as unknown as NewsPostDto;
    expect(classifyNewsFetch(result({ data: { post } }))).toBe('present');
  });
});
