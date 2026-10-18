import ResetPasswordPanel from './ResetPasswordPanel';

/**
 * Password-recovery entry point (`…/reset-password?token=…`, the link the recovery e-mail carries).
 * Like `/replays`, `?token=` is read on the server and handed to the client panel, which posts it
 * through the Next `/api` rewrite.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.token;
  const token = (Array.isArray(raw) ? raw[0] : raw) ?? null;

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-5 py-4 sm:py-8">
      <div className="border-b border-[var(--border-subtle)] pb-4">
        <h1 className="text-xl font-semibold">Đặt lại mật khẩu</h1>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">
          Token đặt lại nằm trong đường dẫn của email khôi phục và chỉ có hiệu lực 1 giờ.
        </p>
      </div>
      <ResetPasswordPanel token={token} />
    </div>
  );
}
