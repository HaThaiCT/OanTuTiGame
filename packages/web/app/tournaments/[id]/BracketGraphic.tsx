'use client';

import { useEffect, useRef, useState } from 'react';
import type { ViewerData } from 'brackets-viewer/dist/types';
import type { BracketEncounter, BracketRound } from '../../../lib/api';
import { encounterStatusLabel, stageLabel } from '../../../lib/labels';

/** Presentation only: no manager, pairing, scoring or replay access is delegated to the vendor. */
export default function BracketGraphic({ encounters, rounds, format }: {
  encounters: readonly BracketEncounter[];
  rounds: readonly BracketRound[];
  format: string;
}) {
  const choices = rounds.filter((round) => format === 'SINGLE_ELIMINATION' ||
    (format === 'SWISS_PLAYOFF' && round.stage === 'PLAYOFF'));
  const [selection, setSelection] = useState(0);
  const [page, setPage] = useState(0);
  const [error, setError] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const round = choices[Math.min(selection, Math.max(0, choices.length - 1))];
  const stage = round?.stage;
  const ordinal = round?.roundOrdinal;
  const slotCount = round?.slotCount ?? 0;

  useEffect(() => {
    const container = root.current;
    if (!container || !stage || ordinal === undefined) return;
    let disposed = false;
    setError(false);
    // The published library exposes a window singleton and no destroy API. A per-render
    // same-origin document owns its DOM, listeners, popover and participant references;
    // removing the frame disposes all of them on prop change or unmount.
    const frame = document.createElement('iframe');
    frame.title = 'Sơ đồ nhánh đấu — danh sách chi tiết và trạng thái bên dưới';
    frame.className = 'h-[540px] w-full border-0';
    container.append(frame);
    const doc = frame.contentDocument!;
    const style = doc.createElement('link');
    style.rel = 'stylesheet';
    style.href = '/brackets/brackets-viewer.min.css';
    doc.head.append(style);
    doc.documentElement.style.colorScheme = 'dark';
    doc.body.style.cssText = 'margin:0;background:#15192b;color:#f8fafc;font-family:system-ui';
    const target = doc.createElement('div');
    target.className = 'brackets-viewer';
    doc.body.append(target);
    const script = doc.createElement('script');
    script.src = '/brackets/brackets-viewer.min.js';
    script.onerror = () => { if (!disposed) setError(true); };
    script.onload = () => {
      if (disposed) return;
      const selected = encounters.filter((item) => item.stage === stage && item.roundOrdinal === ordinal);
      const participants = new Map<string, { id: string; tournament_id: number; name: string }>();
      for (const item of selected) {
        participants.set(item.teamAId, { id: item.teamAId, tournament_id: 0, name: item.teamAName ?? 'Đội chưa đặt tên' });
        if (item.teamBId) participants.set(item.teamBId, { id: item.teamBId, tournament_id: 0, name: item.teamBName ?? 'Đội chưa đặt tên' });
      }
      const data: ViewerData = {
        stages: [{ id: 0, tournament_id: 0, name: `${stageLabel[stage] ?? stage} · Vòng ${ordinal}`, type: 'single_elimination', number: 1, settings: {} }],
        participants: [...participants.values()],
        matchGames: [],
        matches: Array.from({ length: Math.min(16, Math.max(0, slotCount - page * 16)) }, (_, index) => {
          const slot = page * 16 + index + 1;
          const item = selected.find((encounter) => encounter.slotOrdinal === slot);
          const opponent = (id: string | null, score: string | number | null) => id ? {
            id,
            ...(score !== null && Number.isFinite(Number(score)) ? { score: Number(score) } : {}),
            ...(item?.winnerTeamId === id ? { result: 'win' as const } : {}),
          } : null;
          return {
            id: slot, stage_id: 0, group_id: 0, round_id: 0, number: slot, child_count: 0,
            // EMPTY is not BYE. Explicit labels below retain statuses the vendor model lacks.
            status: item?.status === 'RUNNING' ? 3 : item?.status === 'PENDING' ? 2 : 4,
            opponent1: item ? opponent(item.teamAId, item.pointsA) : null,
            opponent2: item ? opponent(item.teamBId, item.pointsB) : null,
          };
        }),
      };
      void frame.contentWindow!.bracketsViewer.render(data, {
        clear: true,
        customRoundName: () => `Vòng ${ordinal}`,
        showSlotsOrigin: false,
        showLowerBracketSlotsOrigin: false,
        highlightParticipantOnHover: false,
      }).then(() => {
        if (disposed) return;
        // Vendor statuses are intentionally not the domain authority.
        for (const match of target.querySelectorAll<HTMLElement>('[data-match-id]')) {
          const slot = Number(match.dataset.matchId);
          const item = selected.find((encounter) => encounter.slotOrdinal === slot);
          const label = doc.createElement('p');
          label.textContent = `#${slot} · ${item ? encounterStatusLabel[item.status] ?? item.status : 'EMPTY — Ô trống'}`;
          match.prepend(label);
        }
      }).catch(() => { if (!disposed) setError(true); });
    };
    doc.head.append(script);
    return () => {
      disposed = true;
      script.onload = null;
      script.onerror = null;
      frame.remove();
    };
  }, [encounters, stage, ordinal, slotCount, page]);

  if (!round) return null;
  return <details className="border-b border-[var(--border-subtle)] px-4 py-3">
    <summary className="cursor-pointer text-sm font-semibold">Sơ đồ đồ họa (brackets-viewer.js)</summary>
    <p className="my-2 text-sm text-[var(--text-secondary)]">Danh sách bên dưới là cách đọc đầy đủ; sơ đồ không tính kết quả hay cấp quyền replay.</p>
    <div className="mb-3 flex flex-wrap gap-3">
      <label>Vòng <select className="rounded border bg-[var(--surface)] p-2" value={selection} onChange={(event) => { setSelection(Number(event.target.value)); setPage(0); }}>
        {choices.map((item, index) => <option key={`${item.stage}-${item.roundOrdinal}`} value={index}>{stageLabel[item.stage] ?? item.stage} · {item.roundOrdinal}</option>)}
      </select></label>
      <label>Nhánh <select className="rounded border bg-[var(--surface)] p-2" value={page} onChange={(event) => setPage(Number(event.target.value))}>
        {Array.from({ length: Math.ceil(slotCount / 16) }, (_, index) => <option key={index} value={index}>Ô {index * 16 + 1}–{Math.min(slotCount, (index + 1) * 16)}</option>)}
      </select></label>
    </div>
    {error ? <p role="status">Không tải được sơ đồ; dùng danh sách đầy đủ bên dưới.</p> : null}
    <div ref={root} />
  </details>;
}
