'use client';

import { useEffect, useRef, useState } from 'react';
import { addOrganizerTeamMember, organizerAccounts, searchOrganizerTeams, type OrganizerAccount, type OrganizerTeamOption, type TeamDto } from '../../lib/api';
import { errorText } from '../../lib/client';
import { availableRosterAccounts } from '../../lib/roster-assignment';
import { isCurrentRosterRequest } from './roster-state';
import { canAddRosterMember, rosterLoadMessage, type RosterLoadState } from './roster-state';

const inputClass = 'h-10 w-full rounded-md border border-[var(--border-control)] bg-[var(--canvas)] px-3 text-sm';
const buttonClass = 'rounded-md border border-[var(--border-control)] px-3 py-2 text-sm disabled:opacity-50';

export function rosterMemberLabel(member: { readonly id: string; readonly username: string; readonly displayName: string; readonly role: string }): string {
  const role = member.role === 'CAPTAIN' ? 'Trưởng đội' : member.role === 'MEMBER' ? 'Thành viên' : member.role;
  return `${member.displayName} · ${member.username} · ${role}`;
}

export default function LanRosterAssignment({ enabled }: { readonly enabled: boolean }) {
  const [query, setQuery] = useState('');
  const [teams, setTeams] = useState<readonly OrganizerTeamOption[]>([]);
  const [teamId, setTeamId] = useState('');
  const [roster, setRoster] = useState<RosterLoadState>({ kind: 'loading' });
  const members = roster.kind === 'loaded' ? roster.members : undefined;
  const accounts = roster.kind === 'loaded' ? roster.accounts as readonly OrganizerAccount[] : [];
  const [userId, setUserId] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingTeams, setLoadingTeams] = useState(false);
  const rosterRequest = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const clean = query.trim();
    if (!clean) { setTeams([]); return; }
    const timer = window.setTimeout(() => {
      setLoadingTeams(true);
      void searchOrganizerTeams(clean, { limit: 10 }).then((response) => {
        if (!alive) return;
        setLoadingTeams(false);
        if (!response.ok || !response.data) { setNotice(errorText(response, 'Không tìm được đội.')); return; }
        setTeams(response.data.teams);
        setNotice(null);
      });
    }, 250);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [enabled, query]);
  async function chooseTeam(team: OrganizerTeamOption) {
    const request = ++rosterRequest.current;
    setTeamId(team.id);
    setUserId('');
    setNotice(null);
    setRoster({ kind: 'loading' });
    setBusy(true);
    const [teamResult, accountResult] = await Promise.all([
      fetch(`/api/v2/teams/${encodeURIComponent(team.id)}`, { cache: 'no-store' }).then(async (response) => ({ ok: response.ok, status: response.status, data: response.ok ? await response.json() as TeamDto : null })),
      organizerAccounts.list(),
    ]);
    if (!isCurrentRosterRequest(request, rosterRequest.current)) return;
    setBusy(false);
    if (!teamResult.ok || !teamResult.data) {
      const message = `Không đọc được roster (HTTP ${teamResult.status}).`;
      setRoster({ kind: 'error', message }); setNotice(message); return;
    }
    if (!accountResult.ok || !accountResult.data) {
      const message = errorText(accountResult, 'Không tải được danh sách tài khoản.');
      setRoster({ kind: 'error', message }); setNotice(message); return;
    }
    setRoster({ kind: 'loaded', members: teamResult.data.members ?? [], accounts: accountResult.data.accounts.filter((account) => account.role === 'STUDENT') });
  }

  async function addMember() {
    if (roster.kind !== 'loaded' || !canAddRosterMember(roster) || !teamId || !userId || busy) return;
    setBusy(true);
    setNotice(null);
    const response = await addOrganizerTeamMember(teamId, userId);
    setBusy(false);
    if (!response.ok || !response.data) { setNotice(errorText(response, 'Không thể thêm thành viên.')); return; }
    setRoster({ kind: 'loaded', members: response.data.members ?? [], accounts: roster.accounts });
    setUserId('');
    setNotice('Đã thêm thành viên vào đội.');
  }

  if (!enabled) return null;
  return (
    <section className="flex flex-col gap-3 rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-4" aria-labelledby="lan-roster-heading">
      <div>
        <h3 id="lan-roster-heading" className="font-semibold">Thành viên đội (LAN)</h3>
        <p className="mt-1 text-xs text-[var(--text-secondary)]">Tìm đội, chọn tài khoản sinh viên đã cấp và thêm trước khi roster bị khóa.</p>
      </div>
      <label className="flex flex-col gap-1 text-sm">Tìm đội theo tên hoặc ID
        <input className={inputClass} value={query} onChange={(event) => setQuery(event.target.value)} maxLength={100} placeholder="Tên đội hoặc UUID" />
      </label>
      {loadingTeams ? <p role="status" className="text-sm">Đang tìm đội…</p> : null}
      {teams.length > 0 ? <ul className="flex max-h-48 flex-col gap-1 overflow-auto">{teams.map((team) => <li key={team.id}><button type="button" className={`${buttonClass} w-full text-left`} disabled={busy} aria-pressed={team.id === teamId} onClick={() => void chooseTeam(team)}>{team.name} · {team.courseCode} · {team.id}</button></li>)}</ul> : null}
      {teamId ? <>
        <h4 className="text-sm font-semibold">Roster hiện tại</h4>
        {roster.kind === 'loading' ? <p role="status" className="text-sm">Đang tải roster và tài khoản…</p> : null}
        {rosterLoadMessage(roster) ? <p role="alert" className="text-sm text-[var(--danger-text)]">{rosterLoadMessage(roster)}</p> : null}
        {roster.kind === 'loaded' && roster.members.length === 0 ? <p className="text-sm text-[var(--text-secondary)]">Đội chưa có thành viên.</p> : null}
        {members?.length ? <ul className="list-disc pl-5 text-sm">{members.map((member) => <li key={member.userId}>{rosterMemberLabel({ id: member.userId, username: member.username, displayName: member.displayName, role: member.role })}</li>)}</ul> : null}
        {roster.kind === 'loaded' && roster.members.length >= 5 ? <p role="status" className="text-sm text-[var(--warning-text)]">Đội đã đạt giới hạn 5 thành viên.</p> : roster.kind === 'loaded' ? <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-60 flex-1 flex-col gap-1 text-sm">Tài khoản sinh viên
            <select className={inputClass} value={userId} onChange={(event) => setUserId(event.target.value)} disabled={busy}>
              <option value="">Chọn tài khoản</option>
              {accounts.filter((account) => !members?.some((member) => member.userId === account.id)).map((account) => <option key={account.id} value={account.id}>{account.displayName} · {account.username}{account.passwordChangeRequired ? ' · cần đổi mật khẩu' : ''}</option>)}
            </select>
          </label>
          <button type="button" className={buttonClass} onClick={() => void addMember()} disabled={busy || !userId || !canAddRosterMember(roster)}>Thêm thành viên</button>
        </div> : null}
      </> : null}
      {notice ? <p role="status" className="text-sm">{notice}</p> : null}
    </section>
  );
}
