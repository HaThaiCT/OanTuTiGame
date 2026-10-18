import VerifyEmailPanel from './VerifyEmailPanel';

/**
 * Mailbox-confirmation entry point (`…/verify-email?token=…`, the link the registration e-mail
 * carries). `?token=` is read on the server — the same pattern `/replays` uses for its query
 * values — and handed to the client panel, which posts it through the Next `/api` rewrite so the
 * token never has to be echoed anywhere else.
 */
export default async function VerifyEmailPage({
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
        <h1 className="text-xl font-semibold">Xác minh email</h1>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">
          Xác minh tài khoản tự đăng ký. Token nằm trong đường dẫn và chỉ có hiệu lực 24 giờ.
        </p>
      </div>
      <VerifyEmailPanel token={token} />
    </div>
  );
}
