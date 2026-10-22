/**
 * Same-origin JSON helper for client components.
 *
 * `next.config.ts` rewrites `/api/:path*` to the Fastify API, so relative paths keep the
 * browser session cookie attached and no CORS/absolute base URL is needed.
 */

export interface ApiResult<T> {
  readonly ok: boolean;
  readonly status: number;
  readonly data: T | null;
  readonly message: string | null;
  /**
   * Machine-readable discriminator the API sends next to `message` (`PROFILE_DISABLED`,
   * `USERNAME_TAKEN`, `EMAIL_VERIFICATION_EXPIRED`, …). Kept separate from `message` so a screen can
   * render the code verbatim without parsing prose.
   */
  readonly code?: string | null;
}

function payloadMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  for (const key of ['message', 'error', 'code']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }
  return null;
}

function payloadCode(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const candidate = (payload as Record<string, unknown>).code;
  return typeof candidate === 'string' && candidate.trim() !== '' ? candidate : null;
}

function statusHint(result: ApiResult<unknown>): string | null {
  if (result.status === 403 && result.message === 'Cross-origin mutation denied') return 'Nguồn trang không khớp cấu hình máy chủ. Hãy mở đúng địa chỉ HTTPS được cấu hình rồi thử lại.';
  if (result.status === 401) return 'Phiên đăng nhập đã hết hạn — hãy đăng nhập lại bằng tài khoản ADMIN.';
  if (result.status === 403) return 'Chỉ tài khoản ADMIN được thực hiện thao tác này.';
  return null;
}

export function errorText(result: ApiResult<unknown>, fallback: string): string {
  const hint = statusHint(result);
  if (hint) return result.message && result.message !== 'Cross-origin mutation denied' ? `${hint} (${result.message})` : hint;
  if (result.message) return result.message;
  return result.status > 0 ? `${fallback} (HTTP ${result.status})` : fallback;
}

/**
 * `errorText` plus the two adjudication block codes the API sends with a 409: the raw message
 * (which starts with the code) is kept verbatim so the operator can quote it, and the Vietnamese
 * explanation is appended after it.
 */
export function adjudicationErrorText(result: ApiResult<unknown>, fallback: string): string {
  const text = errorText(result, fallback);
  if (text.includes('OPEN_DISPUTES_BLOCK_FINALIZATION')) {
    return `${text} — còn tranh chấp chưa xử lý nên chưa thể chốt kết quả chính thức.`;
  }
  if (text.includes('APPEAL_WINDOW_OPEN')) {
    return `${text} — cửa sổ kháng nghị vẫn đang mở nên chưa thể chốt kết quả chính thức.`;
  }
  return text;
}

/**
 * Copy shown next to the password box that resumes a destructive action refused with
 * 403 `REAUTH_REQUIRED` (migration 016: the session must confirm the password again).
 */
export const REAUTH_PROMPT_TEXT = 'Xác nhận lại mật khẩu để tiếp tục';

/**
 * Why the confirmation itself was refused. `errorText` would blame the ADMIN role here, but reaching
 * the action at all already proves the role, so each refusal gets its own honest sentence.
 */
export function reauthErrorText(result: ApiResult<unknown>): string {
  if (result.code === 'INVALID_CREDENTIALS') return 'Mật khẩu không đúng — hãy nhập lại.';
  if (result.code === 'PASSWORD_CHANGE_REQUIRED') {
    return 'PASSWORD_CHANGE_REQUIRED — tài khoản này phải đổi mật khẩu trước khi thực hiện thao tác.';
  }
  if (result.status === 401) return 'Phiên đăng nhập đã hết hạn — hãy đăng nhập lại rồi xác nhận mật khẩu.';
  return result.message ?? `Không xác nhận lại được mật khẩu (HTTP ${result.status}).`;
}

export async function apiRequest<T>(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<ApiResult<T>> {
  const method = init.method ?? 'GET';
  // The API CSRF guard requires application/json on mutations; bodyless POSTs send {}.
  const body = init.body !== undefined ? init.body : method === 'GET' ? undefined : {};
  try {
    const response = await fetch(path, {
      method,
      headers: { ...init.headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    const text = await response.text();
    let payload: unknown = null;
    if (text !== '') {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        payload = null;
      }
    }
    const message = payloadMessage(payload);
    const code = payloadCode(payload);
    if (!response.ok) {
      return { ok: false, status: response.status, data: null, message, code };
    }
    return { ok: true, status: response.status, data: payload as T, message, code };
  } catch {
    return { ok: false, status: 0, data: null, message: 'Không kết nối được API.', code: null };
  }
}
