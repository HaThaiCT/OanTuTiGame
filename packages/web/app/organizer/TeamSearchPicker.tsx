'use client';

import { useEffect, useState } from 'react';
import { searchOrganizerTeams } from '../../lib/api';
import { TeamRatingName } from '../_components/TeamRatingName';

interface OrganizerTeamSearchResult {
  readonly teams: readonly { readonly id: string; readonly name: string; readonly courseId: string; readonly courseCode: string }[];
  readonly total: number;
}

export default function TeamSearchPicker({ onSelect, disabled }: { readonly onSelect: (teamId: string) => void; readonly disabled: boolean }) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<OrganizerTeamSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const clean = query.trim();
    if (!clean) { setResult(null); setError(null); return; }
    let live = true;
    const timer = setTimeout(() => {
      setLoading(true);
      void searchOrganizerTeams(clean).then(response => {
        if (!live) return;
        setLoading(false);
        if (response.ok && response.data) { setResult(response.data); setError(null); }
        else { setError(response.message ?? 'Không tìm được đội.'); }
      });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [query]);

  return <section className="flex min-w-0 flex-col gap-2 rounded-md border border-[var(--border-subtle)] p-3" aria-label="Tìm đội để đăng ký">
    <label className="flex flex-col gap-1 text-xs"><span>Tìm đội theo tên hoặc ID (mọi học phần)</span><input value={query} onChange={event => setQuery(event.target.value)} disabled={disabled} maxLength={100} className="h-10 rounded-md border border-[var(--border-control)] bg-[var(--canvas)] px-3 text-sm" placeholder="Tên đội hoặc UUID" /></label>
    {loading ? <p className="text-xs text-[var(--text-secondary)]">Đang tìm…</p> : null}
    {error ? <p role="alert" className="text-xs text-[var(--danger-text)]">{error}</p> : null}
    {result ? <ul className="flex max-h-48 flex-col gap-1 overflow-auto text-xs">{result.teams.map(team => <li key={team.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-[var(--border-subtle)] p-2"><span><TeamRatingName teamId={team.id} name={team.name} rating={null}/> · {team.courseCode} · <code>{team.id}</code></span><button type="button" disabled={disabled} onClick={() => onSelect(team.id)} className="rounded border border-[var(--border-control)] px-2 py-1">Thêm ID</button></li>)}{result.total > result.teams.length ? <li className="text-[var(--text-secondary)]">Hiển thị {result.teams.length} trong {result.total}; nhập tên hoặc ID cụ thể hơn.</li> : null}</ul> : null}
  </section>;
}
