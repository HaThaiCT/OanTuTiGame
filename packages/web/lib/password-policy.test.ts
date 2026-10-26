import { describe, expect, it } from 'vitest';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, PASSWORD_RULE_HINT, passwordLengthProblem } from './password-policy';

describe('passwordLengthProblem', () => {
  it('mirrors the server boundary at exactly 12 and 128 code points', () => {
    expect(passwordLengthProblem('a'.repeat(11))).toBe('Mật khẩu phải có ít nhất 12 ký tự.');
    expect(passwordLengthProblem('a'.repeat(12))).toBeNull();
    expect(passwordLengthProblem('b'.repeat(128))).toBeNull();
    expect(passwordLengthProblem('c'.repeat(129))).toBe('Mật khẩu tối đa 128 ký tự.');
    expect(passwordLengthProblem('')).toBe('Mật khẩu phải có ít nhất 12 ký tự.');
  });

  it('counts Unicode code points like the server, not UTF-16 units', () => {
    // 13 emoji: 13 code points (≥ 12) but 26 UTF-16 units — the old `.length` comparison required 24.
    expect(Array.from('🚀'.repeat(13)).length).toBe(13);
    expect('🚀'.repeat(13).length).toBe(26);
    expect(passwordLengthProblem('🚀'.repeat(13))).toBeNull();
    expect(passwordLengthProblem('🚀'.repeat(11))).toBe('Mật khẩu phải có ít nhất 12 ký tự.');
    // Over the range purely because of surrogate-units would be a server drift; confirm code points decide.
    expect(passwordLengthProblem('A'.repeat(129))).toBe('Mật khẩu tối đa 128 ký tự.');
  });

  it('exposes the full-range hint both surfaces render, replacing the min-only copy', () => {
    expect(PASSWORD_RULE_HINT).toBe(`Mật khẩu phải có ${MIN_PASSWORD_LENGTH}–${MAX_PASSWORD_LENGTH} ký tự.`);
    expect(PASSWORD_RULE_HINT).not.toContain('tối thiểu 12');
  });
});
