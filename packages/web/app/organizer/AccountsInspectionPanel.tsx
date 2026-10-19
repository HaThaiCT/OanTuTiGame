'use client';

import { useState } from 'react';
import { organizerAccounts, reauth, type OrganizerAccount, type LanCredential, type OrganizerAuditEvent, type InspectedSubmission, type SubmittedSource, type SubmissionBuildLog, type TournamentSummary, type TournamentEntry } from '../../lib/api';
import { errorText, type ApiResult } from '../../lib/client';

const inputClass = 'rounded border border-[var(--border-control)] bg-[var(--canvas)] p-2';
const buttonClass = 'rounded border border-[var(--border-control)] px-3 py-2 disabled:opacity-50';

export default function AccountsInspectionPanel({ authProfile, tournaments, entriesByTournament }: {
  authProfile: string | null; tournaments: readonly TournamentSummary[]; entriesByTournament: Record<string, readonly TournamentEntry[] | null | undefined>;
}) {
  const [accounts, setAccounts] = useState<OrganizerAccount[]>([]);
  const [credentials, setCredentials] = useState<LanCredential[]>([]);
  const [draft, setDraft] = useState('');
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState<OrganizerAuditEvent[]>([]);
  const [resourceId, setResourceId] = useState('');
  const [tournamentId, setTournamentId] = useState('');
  const [teamId, setTeamId] = useState('');
  const [submissions, setSubmissions] = useState<InspectedSubmission[]>([]);
  const [source, setSource] = useState<SubmittedSource | null>(null);
  const [log, setLog] = useState<SubmissionBuildLog | null>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true); setNotice('');
    try { await action(); } catch (error) { setNotice(error instanceof Error ? error.message : 'Thao tác thất bại'); }
    finally { setBusy(false); }
  }
  function unwrap<T>(result: ApiResult<T>): T {
    if (!result.ok || result.data === null) throw new Error(errorText(result, 'Thao tác thất bại'));
    return result.data;
  }
  async function refreshAccounts() {
    setAccounts(unwrap(await organizerAccounts.list()).accounts);
  }
  async function mutateAccount(account: OrganizerAccount, kind: 'reset' | 'revoke') {
    if (!window.confirm(`${kind === 'reset' ? 'Đặt lại mật khẩu và thu hồi mọi phiên' : 'Thu hồi mọi phiên'}: ${account.username}?`)) return;
    await run(async () => {
      unwrap(await reauth(password)); setPassword('');
      if (kind === 'reset') setCredentials([unwrap(await organizerAccounts.reset(account.id))]);
      else { const result = unwrap(await organizerAccounts.revoke(account.id)); setNotice(`Đã thu hồi ${result.revoked} phiên của ${account.username}.`); }
      await refreshAccounts();
    });
  }
  function downloadCredentials() {
    const blob = new Blob([JSON.stringify({ expiresWithinHours: 24, firstLoginOnly: true, credentials }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = 'lan-credentials.json'; link.click(); URL.revokeObjectURL(url);
  }
  function downloadSource() {
    if (!source) return;
    const bytes = Uint8Array.from(atob(source.zipBase64), (char) => char.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
    const link = document.createElement('a'); link.href = url; link.download = `${source.submissionId}.zip`; link.click(); URL.revokeObjectURL(url);
  }

  return <section className="flex flex-col gap-4 rounded border border-[var(--border-subtle)] p-4">
    <h2 className="text-lg font-semibold">Tài khoản LAN · Kiểm tra bài nộp · Nhật ký kiểm toán</h2>
    <p className="text-sm">Chỉ ADMIN đầy đủ quyền. Không truy cập bản nháp hoặc bài chạy thử riêng của đội.</p>
    <button className={buttonClass} disabled={busy} onClick={() => void run(refreshAccounts)}>Tải tài khoản</button>
    {authProfile === 'LAN_OFFLINE' && <form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); void run(async () => {
      const users = draft.split('\n').filter((line) => line.trim()).map((line) => {
        const [username, ...name] = line.split(','); return { username: username.trim(), displayName: name.join(',').trim() || username.trim(), role: 'STUDENT' as const };
      });
      if (!users.length) throw new Error('Nhập ít nhất một tài khoản.');
      setCredentials(unwrap(await organizerAccounts.provision(users)).created); setDraft(''); await refreshAccounts();
    }); }}>
      <label className="flex flex-col gap-1">Cấp tài khoản: mỗi dòng username,tên hiển thị<textarea className={inputClass} value={draft} onChange={(event) => setDraft(event.target.value)} required /></label>
      <button className={buttonClass} disabled={busy}>Cấp và hiển thị thông tin bàn giao</button>
    </form>}
    {credentials.length > 0 && <div className="flex flex-col gap-2 border border-[var(--border-control)] p-3">
      <p>Mật khẩu chỉ hiển thị ở đây, không lưu trong trình duyệt. Hết hạn sau 24 giờ, chỉ đăng nhập lần đầu một lần; phải đổi ngay. Bàn giao riêng cho đúng người.</p>
      {credentials.map((credential) => <p key={credential.userId}><strong>{credential.username}</strong> · {credential.displayName} · <code>{credential.temporaryPassword}</code></p>)}
      <button className={buttonClass} onClick={downloadCredentials}>Tải thông tin bàn giao riêng</button>
      <button className={buttonClass} onClick={() => setCredentials([])}>Ẩn và xóa khỏi màn hình</button>
    </div>}
    <label className="flex flex-col gap-1">Mật khẩu ADMIN xác nhận trước đặt lại / thu hồi<input type="password" autoComplete="current-password" className={inputClass} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
    <ul className="flex flex-col gap-2">{accounts.map((account) => <li key={account.id} className="flex flex-wrap items-center gap-2">
      <span>{account.username} · {account.displayName} · {account.role}{account.passwordChangeRequired ? ' · phải đổi mật khẩu' : ''}</span>
      {authProfile === 'LAN_OFFLINE' && account.role === 'STUDENT' && <button className={buttonClass} disabled={busy || !password} onClick={() => void mutateAccount(account, 'reset')}>Đặt lại mật khẩu</button>}
      <button className={buttonClass} disabled={busy || !password} onClick={() => void mutateAccount(account, 'revoke')}>Thu hồi phiên</button>
      <button className={buttonClass} disabled={busy} onClick={() => void run(async () => { setResourceId(account.id); setEvents(unwrap(await organizerAccounts.audit(account.id)).events); })}>Lịch sử tài khoản</button>
    </li>)}</ul>
    <h3 className="font-semibold">Bài đã nộp (nguồn và log được kiểm toán)</h3>
    <label>Giải <select className={inputClass} value={tournamentId} onChange={(event) => { setTournamentId(event.target.value); setTeamId(''); setSubmissions([]); setSource(null); setLog(null); }}><option value="">Chọn giải</option>{tournaments.map((tournament) => <option key={tournament.id} value={tournament.id}>{tournament.name}</option>)}</select></label>
    <label>Đội <select className={inputClass} value={teamId} onChange={(event) => { setTeamId(event.target.value); setSubmissions([]); setSource(null); setLog(null); }}><option value="">Chọn đội</option>{(entriesByTournament[tournamentId] ?? []).map((entry) => <option key={entry.teamId} value={entry.teamId}>{entry.teamName}</option>)}</select></label>
    <button className={buttonClass} disabled={busy || !tournamentId || !teamId} onClick={() => void run(async () => { setSubmissions(unwrap(await organizerAccounts.submissions(tournamentId, teamId)).submissions); })}>Tải lịch sử bài nộp</button>
    <ul>{submissions.map((submission) => <li key={submission.id} className="flex flex-wrap gap-2 py-2"><span>#{submission.receiptOrdinal} · {submission.language} · {submission.status} · {submission.createdAt}</span>
      <button className={buttonClass} disabled={busy} onClick={() => void run(async () => { setSource(null); setLog(null); setSource(unwrap(await organizerAccounts.source(submission.id))); setLog(unwrap(await organizerAccounts.buildLog(submission.id))); setResourceId(submission.id); setEvents(unwrap(await organizerAccounts.audit(submission.id)).events); })}>Kiểm tra nguồn / log / lịch sử</button>
    </li>)}</ul>
    {source && <div><p>{source.language} · {source.entrypoint} · SHA-256 {source.sourceDigest}</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap">{JSON.stringify(source.manifest, null, 2)}</pre><button className={buttonClass} onClick={downloadSource}>Tải mã nguồn ZIP để kiểm tra</button></div>}
    {log && <div><p>{log.status} · {log.builtAt ?? 'Chưa hoàn tất build'}</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap">{log.buildError ?? 'Không có lỗi build được lưu.'}</pre></div>}
    <h3 className="font-semibold">Nhật ký kiểm toán (200 sự kiện mới nhất)</h3>
    <label className="flex flex-col gap-1">Lọc resource ID (để trống: toàn bộ)<input className={inputClass} value={resourceId} onChange={(event) => setResourceId(event.target.value)} /></label>
    <button className={buttonClass} disabled={busy} onClick={() => void run(async () => { setEvents(unwrap(await organizerAccounts.audit(resourceId)).events); })}>Tải nhật ký</button>
    <ol>{events.map((event) => <li key={event.id} className="border-b border-[var(--border-subtle)] py-2"><p>{event.createdAt} · {event.action} · {event.resourceType}:{event.resourceId} · actor {event.actorUserId}</p><pre className="overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(event.details, null, 2)}</pre></li>)}</ol>
    {notice && <p role="status" className="whitespace-pre-wrap">{notice}</p>}
  </section>;
}
