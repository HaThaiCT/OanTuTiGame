'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { apiRequest } from '../../lib/client';
import { probeAuthProfile, requestEmailChange, reauth, type AuthProfile } from '../../lib/api';
import { passwordLengthProblem } from '../../lib/password-policy';
import UetLogo from '../_components/UetLogo';

type UserAccount = {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  role?: string;
};

export default function OnlineAccountPanel() {
  const [profile, setProfile] = useState<AuthProfile | null>(null);
  const [user, setUser] = useState<UserAccount | null>(null);
  const [loading, setLoading] = useState(true);

  // Email change state
  const [newEmail, setNewEmail] = useState('');
  const [reauthPassword, setReauthPassword] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailNotice, setEmailNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Password change state
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordNotice, setPasswordNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const found = await probeAuthProfile();
      if (!active) return;
      setProfile(found);

      const result = await apiRequest<{ user?: UserAccount; scope?: string }>('/api/v2/auth/me');
      if (active) {
        if (result.ok && result.data?.scope === 'FULL' && result.data.user) {
          setUser(result.data.user);
        } else {
          setUser(null);
        }
        setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  async function handleEmailChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEmailBusy(true);
    setEmailNotice(null);

    const confirmed = await reauth(reauthPassword);
    if (!confirmed.ok) {
      setEmailNotice({
        type: 'error',
        message: confirmed.message ?? 'Mật khẩu xác thực không chính xác.',
      });
      setEmailBusy(false);
      return;
    }

    const result = await requestEmailChange(newEmail);
    if (result.ok) {
      setEmailNotice({
        type: 'success',
        message: 'Yêu cầu đã ghi nhận. Vui lòng kiểm tra email mới để xác minh. Địa chỉ cũ vẫn duy trì hiệu lực cho đến khi xác minh thành công.',
      });
      setNewEmail('');
      setReauthPassword('');
    } else {
      setEmailNotice({
        type: 'error',
        message: result.message ?? 'Không thể yêu cầu đổi email.',
      });
    }
    setEmailBusy(false);
  }

  async function handlePasswordChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPasswordBusy(true);
    setPasswordNotice(null);

    const passwordProblem = passwordLengthProblem(newPassword);
    if (passwordProblem) {
      setPasswordNotice({
        type: 'error',
        message: passwordProblem,
      });
      setPasswordBusy(false);
      return;
    }

    if (newPassword !== confirmPassword) {
      setPasswordNotice({
        type: 'error',
        message: 'Xác nhận mật khẩu mới không khớp.',
      });
      setPasswordBusy(false);
      return;
    }

    const result = await apiRequest('/api/v2/auth/change-password', {
      method: 'POST',
      body: { oldPassword, newPassword },
    });

    if (result.ok) {
      setPasswordNotice({
        type: 'success',
        message: 'Đổi mật khẩu thành công! Các phiên đăng nhập khác đã được cập nhật.',
      });
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } else {
      setPasswordNotice({
        type: 'error',
        message: result.message ?? 'Đổi mật khẩu thất bại. Vui lòng kiểm tra mật khẩu hiện tại.',
      });
    }
    setPasswordBusy(false);
  }

  if (loading) {
    return (
      <div role="status" className="flex flex-col items-center justify-center gap-3 p-12 text-[var(--text-secondary)]">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--border-control)] border-t-[var(--action)]" />
        <span className="text-xs">Đang tải thông tin tài khoản…</span>
      </div>
    );
  }

  if (!user) {
    return (
      <section className="flex flex-col items-center gap-5 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-8 text-center shadow-sm">
        <UetLogo size={48} priority />
        <div className="flex flex-col gap-1.5">
          <h1 className="text-xl font-bold tracking-tight text-[var(--text-primary)]">
            Hồ sơ tài khoản
          </h1>
          <p className="text-xs text-[var(--text-secondary)] max-w-sm">
            Vui lòng đăng nhập để xem thông tin cá nhân, cập nhật mật khẩu và quản lý email liên hệ.
          </p>
        </div>
        <Link
          href="/workspace?returnTo=/account"
          className="vct-btn-primary !w-full sm:!w-auto !py-3 !px-6 !text-sm !rounded-xl"
        >
          Đăng nhập để xem hồ sơ →
        </Link>
        <Link href="/tournaments" className="text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:underline">
          ← Xem danh sách giải đấu
        </Link>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="border-b border-[var(--border-subtle)] pb-4">
        <h1 className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">
          Hồ sơ tài khoản
        </h1>
        <p className="mt-1 text-xs text-[var(--text-secondary)]">
          Xem thông tin cá nhân và quản lý bảo mật tài khoản
        </p>
      </div>

      {/* Account Info Card */}
      <section className="flex flex-col gap-4 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-6 shadow-sm">
        <h2 className="text-base font-semibold text-[var(--text-primary)]">
          Thông tin cá nhân
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="flex flex-col gap-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--canvas-deep)] p-3.5">
            <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-secondary)]">
              Tên hiển thị
            </span>
            <span className="text-sm font-semibold text-[var(--text-primary)] break-words">
              {user.displayName}
            </span>
          </div>
          <div className="flex flex-col gap-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--canvas-deep)] p-3.5">
            <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-secondary)]">
              Tên đăng nhập
            </span>
            <span className="font-mono text-sm font-semibold text-[var(--text-primary)] break-words">
              @{user.username}
            </span>
          </div>
          <div className="flex flex-col gap-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--canvas-deep)] p-3.5">
            <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-secondary)]">
              Email liên kết
            </span>
            <span className="text-sm font-semibold text-[var(--text-primary)] break-words">
              {user.email ?? (
                <span className="italic text-[var(--text-secondary)]">Chưa liên kết</span>
              )}
            </span>
          </div>
        </div>
      </section>

      {/* Change Password Card */}
      <section className="flex flex-col gap-4 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-6 shadow-sm">
        <div>
          <h2 className="text-base font-semibold text-[var(--text-primary)]">
            Đổi mật khẩu
          </h2>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            Mật khẩu mới phải có 12–128 ký tự để đảm bảo an toàn tài khoản.
          </p>
        </div>

        <form onSubmit={handlePasswordChange} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
            <span>Mật khẩu hiện tại</span>
            <input
              name="oldPassword"
              type="password"
              required
              autoComplete="current-password"
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
              className="h-11 rounded-xl border border-[var(--border-control)] bg-[var(--canvas-deep)] px-3.5 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--action)] transition-colors"
            />
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="flex flex-col gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
              <span>Mật khẩu mới (12–128 ký tự)</span>
              <input
                name="newPassword"
                type="password"
                required
                minLength={12}
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="h-11 rounded-xl border border-[var(--border-control)] bg-[var(--canvas-deep)] px-3.5 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--action)] transition-colors"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
              <span>Xác nhận mật khẩu mới</span>
              <input
                name="confirmPassword"
                type="password"
                required
                minLength={12}
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="h-11 rounded-xl border border-[var(--border-control)] bg-[var(--canvas-deep)] px-3.5 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--action)] transition-colors"
              />
            </label>
          </div>

          {passwordNotice ? (
            <div
              role={passwordNotice.type === 'success' ? 'status' : 'alert'}
              className={`rounded-xl px-3.5 py-2.5 text-xs border ${
                passwordNotice.type === 'success'
                  ? 'border-[var(--success-text)] bg-[var(--success-tint)] text-[var(--success-text)]'
                  : 'border-[var(--danger-text)] bg-[var(--danger-tint)] text-[var(--danger-text)]'
              }`}
            >
              {passwordNotice.message}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={passwordBusy || !oldPassword || !newPassword || !confirmPassword}
            className="vct-btn-primary self-start !py-2.5 !px-5 !text-xs !rounded-xl disabled:opacity-60 cursor-pointer"
          >
            {passwordBusy ? 'Đang cập nhật...' : 'Cập nhật mật khẩu'}
          </button>
        </form>
      </section>

      {/* Change Email Card (Only in ONLINE profile) */}
      {profile === 'ONLINE' ? (
        <section className="flex flex-col gap-4 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-6 shadow-sm">
          <div>
            <h2 className="text-base font-semibold text-[var(--text-primary)]">
              Đổi địa chỉ email
            </h2>
            <p className="mt-1 text-xs text-[var(--text-secondary)]">
              Cần nhập lại mật khẩu hiện tại để xác thực thao tác nhạy cảm này.
            </p>
          </div>

          <form onSubmit={handleEmailChange} className="flex flex-col gap-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label className="flex flex-col gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
                <span>Địa chỉ email mới</span>
                <input
                  type="email"
                  required
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="name@example.com"
                  className="h-11 rounded-xl border border-[var(--border-control)] bg-[var(--canvas-deep)] px-3.5 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--action)] transition-colors"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
                <span>Mật khẩu hiện tại để xác thực</span>
                <input
                  type="password"
                  required
                  autoComplete="current-password"
                  value={reauthPassword}
                  onChange={(e) => setReauthPassword(e.target.value)}
                  className="h-11 rounded-xl border border-[var(--border-control)] bg-[var(--canvas-deep)] px-3.5 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--action)] transition-colors"
                />
              </label>
            </div>

            <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
              Liên kết xác minh sẽ được gửi tới địa chỉ email mới. Địa chỉ cũ vẫn có hiệu lực cho tới khi bạn hoàn tất xác minh.
            </p>

            {emailNotice ? (
              <div
                role={emailNotice.type === 'success' ? 'status' : 'alert'}
                className={`rounded-xl px-3.5 py-2.5 text-xs border ${
                  emailNotice.type === 'success'
                    ? 'border-[var(--success-text)] bg-[var(--success-tint)] text-[var(--success-text)]'
                    : 'border-[var(--danger-text)] bg-[var(--danger-tint)] text-[var(--danger-text)]'
                }`}
              >
                {emailNotice.message}
              </div>
            ) : null}

            <button
              type="submit"
              disabled={emailBusy || !newEmail || !reauthPassword}
              className="vct-btn-primary self-start !py-2.5 !px-5 !text-xs !rounded-xl disabled:opacity-60 cursor-pointer"
            >
              {emailBusy ? 'Đang gửi yêu cầu...' : 'Xác nhận và yêu cầu đổi email'}
            </button>
          </form>
        </section>
      ) : profile === 'LAN_OFFLINE' ? (
        <section className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)] p-5 text-xs text-[var(--text-secondary)]">
          Hệ thống đang hoạt động ở chế độ LAN_OFFLINE. Tính năng email không được kích hoạt trên hệ thống mạng nội bộ này.
        </section>
      ) : null}
    </div>
  );
}
