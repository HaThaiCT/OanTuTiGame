import VerifyEmailPanel from './VerifyEmailPanel';

/** Client panel reads the token from the URL fragment; the server must never receive it. */
export default function VerifyEmailPage() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-5 py-4 sm:py-8">
      <div className="border-b border-[var(--border-subtle)] pb-4">
        <h1 className="text-xl font-semibold">Xác minh email</h1>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">
          Xác minh tài khoản tự đăng ký. Token được giữ trong phần #token= của liên kết và chỉ có hiệu lực 24 giờ.
        </p>
      </div>
      <VerifyEmailPanel />
    </div>
  );
}
