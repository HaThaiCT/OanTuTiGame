/**
 * Client-side mirror of the server password rule (`packages/server/src/identity/crypto.ts`
 * `validPassword`): 12–128 Unicode code points. Lengths are counted with `Array.from` because
 * the server measures code points, not UTF-16 units — a password of multi-byte characters must
 * share the same verdict on both ends.
 */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

/** Full-range hint rendered next to every password field (replaces the min-only copy). */
export const PASSWORD_RULE_HINT = `Mật khẩu phải có ${MIN_PASSWORD_LENGTH}–${MAX_PASSWORD_LENGTH} ký tự.`;

/**
 * Vietnamese refusal for a password outside the server's 12–128 range; `null` when valid.
 * `WEAK_PASSWORD` bodies from the API mean the whole range, so every surface must pass a full
 * range check before shipping the request.
 */
export function passwordLengthProblem(password: string): string | null {
  const length = Array.from(password).length;
  if (length < MIN_PASSWORD_LENGTH) {
    return `Mật khẩu phải có ít nhất ${MIN_PASSWORD_LENGTH} ký tự.`;
  }
  if (length > MAX_PASSWORD_LENGTH) {
    return `Mật khẩu tối đa ${MAX_PASSWORD_LENGTH} ký tự.`;
  }
  return null;
}
