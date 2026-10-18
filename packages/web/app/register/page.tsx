'use client';

import Link from 'next/link';
import { useState } from 'react';
import { errorText } from '../../lib/client';
import { isProfileDisabled, registerAccount, type RegisterReceipt } from '../../lib/api';
import { OnlineOnlyNotice, ProfileProbeNotice, useAuthProfile } from '../_components/AuthProfile';

/** Client-side mirror of the server rules (`packages/server/src/identity/service.ts`). */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 12;
const MAX_USERNAME_LENGTH = 50;
const MAX_DISPLAY_NAME_LENGTH = 100;

const FIELD_CLASS =
  'h-10 rounded-sm border border-[var(--border-control)] bg-[var(--canvas)] px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--action)]';

interface FormValues {
  username: string;
  displayName: string;
  email: string;
  password: string;
  confirm: string;
}

const EMPTY_VALUES: FormValues = { username: '', displayName: '', email: '', password: '', confirm: '' };

/** Mirrors the server checks so an obviously invalid form never leaves the browser. */
function validationProblem(values: FormValues): string | null {
  const username = values.username.trim();
  if (username.length < 3 || username.length > MAX_USERNAME_LENGTH) {
    return `Tên đăng nhập phải từ 3 đến ${MAX_USERNAME_LENGTH} ký tự.`;
  }
  if (values.displayName.trim().length > MAX_DISPLAY_NAME_LENGTH) {
    return `Tên hiển thị tối đa ${MAX_DISPLAY_NAME_LENGTH} ký tự.`;
  }
  if (!EMAIL_PATTERN.test(values.email.trim())) return 'Email không đúng định dạng.';
  if (values.password.length < MIN_PASSWORD_LENGTH) {
    return `Mật khẩu phải có ít nhất ${MIN_PASSWORD_LENGTH} ký tự.`;
  }
  if (values.password !== values.confirm) return 'Xác nhận mật khẩu không khớp.';
  return null;
}

export default function RegisterPage() {
  const profile = useAuthProfile();
  const [values, setValues] = useState<FormValues>(EMPTY_VALUES);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<RegisterReceipt | null>(null);
  /** Raw `PROFILE_DISABLED` message from the API: evidence that this deployment is LAN_OFFLINE. */
  const [profileRefusal, setProfileRefusal] = useState<string | null>(null);

  function update(field: keyof FormValues, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const problem = validationProblem(values);
    if (problem) {
      setError(problem);
      setCode(null);
      return;
    }
    setBusy(true);
    setError(null);
    setCode(null);
    const result = await registerAccount({
      username: values.username.trim(),
      displayName: values.displayName.trim(),
      email: values.email.trim(),
      password: values.password,
    });
    setBusy(false);
    if (!result.ok) {
      if (isProfileDisabled(result)) {
        setProfileRefusal(result.message);
        return;
      }
      setError(errorText(result, 'Đăng ký thất bại.'));
      setCode(result.code ?? null);
      return;
    }
    setReceipt(result.data);
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-5 py-4 sm:py-8">
      <div className="border-b border-[var(--border-subtle)] pb-4">
        <h1 className="text-xl font-semibold">Đăng ký tài khoản</h1>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">
          Tự đăng ký chỉ có trên cấu hình ONLINE. Tài khoản tạo ra có vai trò STUDENT và phải xác minh email.
        </p>
      </div>

      {profile === 'LAN_OFFLINE' || profileRefusal ? <OnlineOnlyNotice message={profileRefusal} /> : null}

      {profile === undefined ? <ProfileProbeNotice /> : null}

      {receipt ? (
        <section className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-5">
          <h2 className="text-base font-semibold text-[var(--success-text)]">Đăng ký đã được ghi nhận</h2>
          <p className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
            Tài khoản{' '}
            <span className="font-semibold text-[var(--text-primary)]">{receipt.user.username}</span> (vai trò{' '}
            {receipt.user.role || 'STUDENT'}) đã được tạo trên server.
            {receipt.emailVerificationRequired
              ? ' Hãy kiểm tra email để xác minh — môi trường phát triển có thể hiển thị token qua outbox.'
              : ' Tài khoản đã sẵn sàng đăng nhập.'}
          </p>
          <Link
            href="/workspace"
            className="mt-4 inline-block rounded-md bg-[var(--action)] px-4 py-2 text-sm font-semibold text-[#0B0D17]"
          >
            Tới trang đăng nhập →
          </Link>
        </section>
      ) : null}

      {profile === 'ONLINE' && !receipt && !profileRefusal ? (
        <form onSubmit={submit} className="flex flex-col gap-4 rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-5">
          <label className="flex flex-col gap-2 text-sm">
            <span className="font-medium">Tên đăng nhập</span>
            <input
              name="username"
              required
              autoComplete="username"
              value={values.username}
              onChange={(event) => update('username', event.target.value)}
              className={FIELD_CLASS}
            />
            <span className="text-xs text-[var(--text-secondary)]">3–{MAX_USERNAME_LENGTH} ký tự, dùng để đăng nhập.</span>
          </label>

          <label className="flex flex-col gap-2 text-sm">
            <span className="font-medium">Tên hiển thị</span>
            <input
              name="displayName"
              autoComplete="name"
              value={values.displayName}
              onChange={(event) => update('displayName', event.target.value)}
              className={FIELD_CLASS}
            />
            <span className="text-xs text-[var(--text-secondary)]">
              Tối đa {MAX_DISPLAY_NAME_LENGTH} ký tự; để trống sẽ dùng tên đăng nhập.
            </span>
          </label>

          <label className="flex flex-col gap-2 text-sm">
            <span className="font-medium">Email</span>
            <input
              name="email"
              type="email"
              required
              autoComplete="email"
              value={values.email}
              onChange={(event) => update('email', event.target.value)}
              className={FIELD_CLASS}
            />
            <span className="text-xs text-[var(--text-secondary)]">Địa chỉ nhận liên kết xác minh (hiệu lực 24 giờ).</span>
          </label>

          <label className="flex flex-col gap-2 text-sm">
            <span className="font-medium">Mật khẩu</span>
            <input
              name="password"
              type="password"
              required
              autoComplete="new-password"
              value={values.password}
              onChange={(event) => update('password', event.target.value)}
              className={FIELD_CLASS}
            />
            <span className="text-xs text-[var(--text-secondary)]">Tối thiểu {MIN_PASSWORD_LENGTH} ký tự.</span>
          </label>

          <label className="flex flex-col gap-2 text-sm">
            <span className="font-medium">Xác nhận mật khẩu</span>
            <input
              name="confirm"
              type="password"
              required
              autoComplete="new-password"
              value={values.confirm}
              onChange={(event) => update('confirm', event.target.value)}
              className={FIELD_CLASS}
            />
            <span className="text-xs text-[var(--text-secondary)]">Nhập lại đúng mật khẩu ở trên.</span>
          </label>

          {error ? (
            <p className="rounded-md border border-[var(--danger-text)] px-3 py-2 text-sm text-[var(--danger-text)]">
              {error}
              {code ? <span className="ml-2 font-mono text-xs break-all text-[var(--text-secondary)]">{code}</span> : null}
            </p>
          ) : null}

          <button disabled={busy} className="h-10 rounded-sm bg-[var(--action)] text-sm font-semibold text-[#151618] hover:bg-[var(--action-hover)] disabled:opacity-60">
            {busy ? 'Đang đăng ký…' : 'Đăng ký'}
          </button>
          <p className="text-xs text-[var(--text-secondary)]">
            Đã có tài khoản?{' '}
            <Link href="/workspace" className="underline hover:text-[var(--text-primary)]">
              Đăng nhập
            </Link>
          </p>
        </form>
      ) : null}

      {profile === null && !profileRefusal ? (
        <p className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-5 text-sm text-[var(--text-secondary)]">
          Không xác định được cấu hình xác thực của server nên trang đăng ký chưa được mở. Hãy kiểm tra kết nối API rồi tải lại.
        </p>
      ) : null}
    </div>
  );
}
