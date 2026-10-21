'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { apiRequest, type ApiResult } from '../../lib/client';
import { probeAuthProfile, requestEmailChange, reauth, type AuthProfile } from '../../lib/api';

type UserAccount = { id: string; username: string; displayName: string; email: string | null };

export default function OnlineAccountPanel() {
  const [profile, setProfile] = useState<AuthProfile | null>(null);
  const [user, setUser] = useState<UserAccount | null>(null);
  const [newEmail, setNewEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    void probeAuthProfile().then(async found => {
      if (!active) return;
      setProfile(found);
      if (found !== 'ONLINE') { setLoading(false); return; }
      const result = await apiRequest<{ user?: UserAccount; scope?: string }>('/api/v2/auth/me');
      if (active && result.ok && result.data?.scope === 'FULL' && result.data.user) setUser(result.data.user);
      setLoading(false);
    });
    return () => { active = false; };
  }, []);
  async function changeEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setNotice(null);
    const confirmed = await reauth(password);
    if (!confirmed.ok) { setNotice(confirmed.message ?? 'Xác thực lại thất bại.'); setBusy(false); return; }
    const result = await requestEmailChange(newEmail);
    setNotice(result.ok ? 'Yêu cầu đã ghi nhận; hãy xác minh địa chỉ mới. Địa chỉ cũ sẽ nhận thông báo.' : result.message ?? 'Không thể yêu cầu đổi email.');
    setPassword(''); setBusy(false);
  }
  async function run(action: () => Promise<ApiResult<unknown>>) {
    setBusy(true);
    try { const result = await action(); setNotice(result.ok ? 'Yêu cầu đã được ghi nhận.' : result.message ?? 'Không thể hoàn tất yêu cầu.'); }
    finally { setBusy(false); }
  }
  if (profile !== 'ONLINE') return <section className="mx-auto max-w-lg p-6" role="status">{profile === null ? 'Không thể xác định hồ sơ máy chủ; tài khoản và thao tác ONLINE đã bị khóa.' : 'Tính năng này chỉ khả dụng trên hồ sơ ONLINE.'}</section>;
  if (loading) return <p role="status">Đang tải tài khoản…</p>;
  if (!user) return <section role="alert">Không thể xác thực phiên tài khoản. Hãy đăng nhập lại.</section>;
  return <section className="mx-auto flex w-full max-w-lg flex-col gap-5 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] p-6">
    <h1 className="text-2xl font-semibold">Tài khoản ONLINE</h1>
    <p>{user.displayName} · {user.username} · {user.email ?? 'Chưa có email'}</p>
    <form className="flex flex-col gap-2" onSubmit={changeEmail}>
      <label>Email mới<input required type="email" value={newEmail} onChange={event => setNewEmail(event.target.value)} /></label>
      <label>Mật khẩu hiện tại để xác nhận<input required type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} /></label>
      <button disabled={busy || !newEmail || !password} className="vct-btn-primary">Xác nhận lại và yêu cầu đổi email</button>
      <p className="text-xs text-[var(--text-secondary)]">Địa chỉ mới cần được xác minh; địa chỉ cũ sẽ nhận thông báo. Chưa xác minh thì email hiện tại vẫn có hiệu lực.</p>
    </form>
    <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); void run(() => apiRequest('/api/v2/auth/change-password', { method: 'POST', body: { oldPassword: data.get('oldPassword'), newPassword: data.get('newPassword') } })); }}>
      <label className="flex flex-col gap-2">Mật khẩu hiện tại<input name="oldPassword" type="password" required autoComplete="current-password" /></label>
      <label className="flex flex-col gap-2">Mật khẩu mới<input name="newPassword" type="password" required minLength={12} autoComplete="new-password" /></label>
      <button disabled={busy} className="vct-btn-primary">Đổi mật khẩu</button>
    </form>
    {notice ? <p role="status">{notice}</p> : null}
  </section>;
}
