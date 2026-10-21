import ResetPasswordPanel from './ResetPasswordPanel';

/**
 * Password-recovery token is in a URL fragment; server renders no token and the fragment is not sent in referrers.
 * The client panel reads it and posts it through the same-origin `/api` rewrite.
 */
export default function ResetPasswordPage() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-5 py-4 sm:py-8">
      <div className="border-b border-[var(--border-subtle)] pb-4">
        <h1 className="text-xl font-semibold">Đặt lại mật khẩu</h1>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">Token đặt lại chỉ có hiệu lực 30 phút.</p>
      </div>
      <ResetPasswordPanel />
    </div>
  );
}
