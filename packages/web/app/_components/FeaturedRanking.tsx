'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { StandingRow } from '../../lib/api';

interface Ranking {
  id: string;
  name: string;
  round: number;
  rows: StandingRow[];
}
type Column = 'rank' | 'teamName' | 'points' | 'matchesPlayed';

export default function FeaturedRanking({ rankings }: { rankings: Ranking[] }) {
  const [selectedId, setSelectedId] = useState(rankings[0]?.id ?? '');
  const [sort, setSort] = useState<{ column: Column; ascending: boolean }>({ column: 'rank', ascending: true });
  const selected = rankings.find(ranking => ranking.id === selectedId);
  const rows = [...(selected?.rows ?? [])].sort((a, b) => {
    const comparison = sort.column === 'teamName'
      ? a.teamName.localeCompare(b.teamName, 'vi')
      : Number(a[sort.column]) - Number(b[sort.column]);
    return (sort.ascending ? comparison : -comparison) || a.rank - b.rank;
  });
  const columns: { column: Column; label: string }[] = [
    { column: 'rank', label: 'Hạng' }, { column: 'teamName', label: 'Đội' },
    { column: 'points', label: 'Điểm' }, { column: 'matchesPlayed', label: 'Trận' },
  ];
  return <section className="arena-ranking" aria-label="Bảng xếp hạng giải đấu">
    <div className="arena-ranking-toolbar">
      <label className="sr-only" htmlFor="featured-tournament">Chọn giải xem xếp hạng</label>
      <select id="featured-tournament" value={selectedId} onChange={event => setSelectedId(event.target.value)} disabled={rankings.length === 0}>
        {rankings.length === 0 ? <option value="">Chưa có bảng xếp hạng công bố</option> : rankings.map(ranking => <option key={ranking.id} value={ranking.id}>{ranking.name} · Vòng {ranking.round}</option>)}
      </select>
    </div>
    <table><thead><tr>{columns.map(({ column, label }) => <th key={column} aria-sort={sort.column === column ? (sort.ascending ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={() => setSort({ column, ascending: sort.column === column ? !sort.ascending : column === 'rank' || column === 'teamName' })}>{label}<span aria-hidden="true">{sort.column === column ? (sort.ascending ? '↑' : '↓') : '↕'}</span></button>
    </th>)}</tr></thead><tbody>{rows.slice(0, 8).map(row => <tr key={row.teamId}><td className="text-[var(--text-secondary)]">{row.rank}</td><td>{row.teamName}</td><td>{row.points}</td><td className="text-[var(--text-secondary)]">{row.matchesPlayed}</td></tr>)}</tbody></table>
    {rows.length === 0 ? <div className="arena-empty">Chưa có bảng xếp hạng đã công bố.<br/>Kết quả xuất hiện khi vòng đấu được chốt.</div> : null}
    <Link className="arena-ranking-footer" href={selected ? `/tournaments/${selected.id}` : '#tournaments'}>Xem {selected ? 'bảng xếp hạng' : 'các giải đấu'} đầy đủ →</Link>
  </section>;
}
