import { describe, expect, it } from 'vitest';
import { errorText } from './client';

describe('API error copy', () => {
  it('explains an ONLINE origin refusal instead of blaming the user role', () => {
    expect(errorText({ ok: false, status: 403, data: null, message: 'Cross-origin mutation denied', code: null }, 'Đăng ký thất bại.'))
      .toContain('mở đúng địa chỉ HTTPS');
    expect(errorText({ ok: false, status: 403, data: null, message: 'ADMIN scope required', code: null }, 'Thao tác thất bại.'))
      .toContain('Chỉ tài khoản ADMIN');
  });
});
