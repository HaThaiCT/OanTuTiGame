/**
 * Sanitizes returnTo parameter to prevent open redirect vulnerabilities.
 * Only accepts valid relative paths on the same origin (starting with a single '/').
 */
export function safeReturnTo(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') {
    return null;
  }
  const trimmed = url.trim();
  if (!trimmed) {
    return null;
  }
  // Must start with a single '/'
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) {
    return null;
  }
  // Disallow backslashes to prevent browser protocol/domain parsing anomalies
  if (trimmed.includes('\\')) {
    return null;
  }
  // Disallow control characters (\x00-\x1F, \x7F)
  if (/[\x00-\x1F\x7F]/.test(trimmed)) {
    return null;
  }
  try {
    const parsed = new URL(trimmed, 'http://localhost');
    if (parsed.protocol !== 'http:' || parsed.host !== 'localhost') {
      return null;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}
