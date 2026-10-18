'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { fetchAuthMe, joinTournamentWithCode, listTournamentEntries } from '../../../lib/api';
import { errorText } from '../../../lib/client';

const INPUT_CLASS =
  'h-10 w-full min-w-0 rounded-md border border-[var(--border-control)] bg-[var(--canvas)] px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-secondary)]';
const BUTTON_CLASS = 'h-10 rounded-md bg-[var(--action)] px-4 text-sm font-semibold text-[#0B0D17] disabled:opacity-60';

/**
 * Captain-side join with a shared entry code (ONLINE profile only). The team picker lists only the
 * caller's own teams, and any failure (wrong code, expired, full tournament, already enrolled) is
 * reported verbatim from the API rather than guessed at.
 */
export default function JoinWithCode({
  tournamentId,
  state,
}: {
  readonly tournamentId: string;
  readonly state: string;
}) {
  const router = useRouter();
  const [profile, setProfile] = useState<'ONLINE' | 'LAN_OFFLINE' | null>(null);
  const [teams, setTeams] = useState<readonly { id: string; name: string | null }[]>([]);
  const [teamId, setTeamId] = useState('');
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState<{ readonly kind: 'success' | 'error'; readonly text: string } | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const session = await fetchAuthMe();
      if (cancelled || !session.ok || !session.data) return;
      setProfile(session.data.authProfile);
      if (session.data.authProfile !== 'ONLINE' || session.data.teamIds.length === 0) return;
      // Team names come from the public entry list; unknown ids fall back to the id itself.
      let names = new Map<string, string>();
      try {
        const entries = (await listTournamentEntries(tournamentId)) ?? [];
        names = new Map(entries.filter((entry) => entry.teamId).map((entry) => [entry.teamId, entry.teamName]));
      } catch {
        names = new Map();
      }
      if (cancelled) return;
      const mine = session.data.teamIds.map((id) => ({ id, name: names.get(id) ?? null }));
      setTeams(mine);
      setTeamId(mine[0]?.id ?? '');
    })();
    return () => {
      cancelled = true;
    };
  }, [tournamentId]);

  async function join() {
    const trimmed = code.trim();
    if (trimmed === '' || teamId === '') {
      setNotice({ kind: 'error', text: 'Chọn đội của bạn và nhập mã vào giải.' });
      return;
    }
    setPending(true);
    const result = await joinTournamentWithCode(tournamentId, { code: trimmed, teamId });
    setPending(false);
    if (!result.ok) {
      setNotice({ kind: 'error', text: errorText(result, 'Tham gia giải thất bại.') });
      return;
    }
    setCode('');
    setNotice({
      kind: 'success',
      text: `Đã tham gia giải. Đội của bạn đang ở trạng thái ${result.data?.status ?? 'ELIGIBLE'}.`,
    });
    router.refresh();
  }

  if (profile !== 'ONLINE' || state !== 'REGISTRATION_OPEN' || teams.length === 0) return null;

  return (
    <section className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] px-4 py-4">
      <h2 className="text-base font-semibold">Tham gia bằng mã vào giải</h2>
      <p className="mt-1 text-sm text-[var(--text-secondary)]">
        Giảng viên gửi một mã dùng chung; mỗi đội trưởng tự thêm đội của mình. Mã sai, hết hạn, hết lượt hoặc giải
        đã đầy đều được báo rõ.
      </p>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-[var(--text-secondary)]">
          <span>Đội của bạn</span>
          <select value={teamId} onChange={(event) => setTeamId(event.target.value)} className={INPUT_CLASS}>
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name ? `${team.name} (${team.id.slice(0, 8)}…)` : team.id}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-[var(--text-secondary)]">
          <span>Mã vào giải</span>
          <input
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="Ví dụ: ARENA-4F2K"
            className={`${INPUT_CLASS} font-mono uppercase`}
          />
        </label>
        <button type="button" disabled={pending} onClick={() => void join()} className={BUTTON_CLASS}>
          {pending ? 'Đang tham gia…' : 'Tham gia giải'}
        </button>
      </div>
      {notice ? (
        <p
          className={
            notice.kind === 'error'
              ? 'mt-3 rounded-md border border-[var(--danger-text)] px-3 py-2 text-xs text-[var(--danger-text)]'
              : 'mt-3 rounded-md border border-[var(--success-text)] px-3 py-2 text-xs text-[var(--success-text)]'
          }
        >
          {notice.text}
        </p>
      ) : null}
    </section>
  );
}
