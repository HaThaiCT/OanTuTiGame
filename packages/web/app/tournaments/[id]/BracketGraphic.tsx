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
    frame.title = 'Sơ đồ nhánh đấu trực quan';
    frame.className = 'w-full border-0 bg-[#0b1118] rounded-xl transition-all duration-300';
    frame.style.height = '340px';
    container.append(frame);
    const doc = frame.contentDocument!;
    const style = doc.createElement('link');
    style.rel = 'stylesheet';
    style.href = '/brackets/brackets-viewer.min.css';
    doc.head.append(style);
    const customStyle = doc.createElement('style');
    customStyle.textContent = `
      * { box-sizing: border-box; }
      html, body {
        margin: 0;
        padding: 0;
        background: #0b1118 !important;
        color: #ece8e1 !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
        overflow-x: auto;
      }
      .brackets-viewer {
        --primary-background: #0b1118 !important;
        --secondary-background: #17202a !important;
        --match-background: #17202a !important;
        --font-color: #ece8e1 !important;
        --win-color: #00f5d4 !important;
        --loss-color: #ff4655 !important;
        --label-color: #9aa6b1 !important;
        --hint-color: #6c7780 !important;
        --connector-color: rgba(236, 232, 225, 0.25) !important;
        --border-color: rgba(236, 232, 225, 0.14) !important;
        --border-hover-color: #ff4655 !important;
        --border-selected-color: #00f5d4 !important;
        --text-size: 13px !important;
        --round-margin: 50px !important;
        --match-width: 250px !important;
        --match-horizontal-padding: 12px !important;
        --match-vertical-padding: 8px !important;
        --connector-border-width: 2px !important;
        --match-border-width: 1px !important;
        --match-border-radius: 10px !important;
        background: #0b1118 !important;
        color: #ece8e1 !important;
        padding: 20px 32px !important;
      }
      .brackets-viewer h1 {
        display: none !important;
      }
      .brackets-viewer h2 {
        font-size: 1.2em !important;
        color: #9aa6b1 !important;
        margin-bottom: 12px !important;
      }
      .brackets-viewer h3 {
        width: 250px !important;
        background: #17202a !important;
        color: #ece8e1 !important;
        border: 1px solid rgba(236, 232, 225, 0.14) !important;
        border-radius: 8px !important;
        font-family: inherit !important;
        font-weight: 700 !important;
        font-size: 12px !important;
        letter-spacing: 0.05em !important;
        text-transform: uppercase !important;
        padding: 8px 12px !important;
        margin-bottom: 16px !important;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25) !important;
      }
      .brackets-viewer .match {
        width: 250px !important;
        display: flex !important;
        flex-direction: column !important;
        align-items: stretch !important;
        margin: 14px 0 !important;
      }
      .brackets-viewer .match p {
        margin: 0 0 6px 0 !important;
        font-family: monospace !important;
        font-size: 11px !important;
        font-weight: 600 !important;
        color: #9aa6b1 !important;
        white-space: nowrap !important;
        width: 100% !important;
      }
      .brackets-viewer .opponents {
        width: 100% !important;
        background: #17202a !important;
        border: 1px solid rgba(236, 232, 225, 0.14) !important;
        border-radius: 10px !important;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3) !important;
        transition: all 0.2s ease !important;
      }
      .brackets-viewer .opponents:hover {
        border-color: #ff4655 !important;
        box-shadow: 0 6px 20px rgba(255, 70, 85, 0.25) !important;
        transform: translateY(-1px) !important;
      }
      .brackets-viewer .opponents > span {
        background: #0b1118 !important;
        color: #9aa6b1 !important;
        border: 1px solid rgba(236, 232, 225, 0.15) !important;
        border-radius: 4px !important;
        font-family: monospace !important;
        font-size: 10px !important;
        font-weight: 600 !important;
        padding: 1px 6px !important;
        top: -9px !important;
      }
      .brackets-viewer .participant {
        background: #17202a !important;
        color: #ece8e1 !important;
        padding: 8px 14px !important;
        font-size: 13px !important;
        font-weight: 500 !important;
        display: flex !important;
        align-items: center !important;
        justify-content: space-between !important;
      }
      .brackets-viewer .participant:nth-of-type(1) {
        border-bottom: 1px solid rgba(236, 232, 225, 0.08) !important;
        border-top-left-radius: 10px !important;
        border-top-right-radius: 10px !important;
      }
      .brackets-viewer .participant:nth-of-type(2) {
        border-bottom-left-radius: 10px !important;
        border-bottom-right-radius: 10px !important;
      }
      .brackets-viewer .participant.hover {
        background: #212d39 !important;
      }
      .brackets-viewer .participant .name {
        width: auto !important;
        max-width: 170px !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
      }
      .brackets-viewer .participant.win .name {
        color: #00f5d4 !important;
        font-weight: 700 !important;
      }
      .brackets-viewer .participant.win .result {
        color: #00f5d4 !important;
        font-weight: 800 !important;
        font-family: monospace !important;
      }
      .brackets-viewer .participant.loss .name {
        color: #6c7780 !important;
      }
      .brackets-viewer .participant.loss .result {
        color: #ff4655 !important;
        font-family: monospace !important;
      }
    `;
    doc.head.append(customStyle);
    doc.documentElement.style.colorScheme = 'dark';
    doc.body.style.cssText = 'margin:0;background:#0b1118;color:#ece8e1;';
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
        // Auto-adapt iframe height to content
        const contentHeight = Math.max(280, doc.body.scrollHeight + 30);
        frame.style.height = `${contentHeight}px`;
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
  return (
    <div className="border-b border-[var(--border-subtle)] p-5">
      {choices.length > 1 || slotCount > 16 ? (
        <div className="mb-4 flex flex-wrap items-center gap-3 font-mono text-xs text-[var(--text-secondary)]">
          {choices.length > 1 ? (
            <label className="flex items-center gap-2">
              <span>VÒNG ĐẤU:</span>
              <select
                className="rounded-lg border border-[var(--border-control)] bg-[var(--surface-subtle)] px-3 py-1.5 text-xs text-[var(--text-primary)] font-medium outline-none focus:border-[var(--action)]"
                value={selection}
                onChange={(event) => { setSelection(Number(event.target.value)); setPage(0); }}
              >
                {choices.map((item, index) => (
                  <option key={`${item.stage}-${item.roundOrdinal}`} value={index}>
                    {stageLabel[item.stage] ?? item.stage} · Vòng {item.roundOrdinal}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {slotCount > 16 ? (
            <label className="flex items-center gap-2">
              <span>NHÁNH:</span>
              <select
                className="rounded-lg border border-[var(--border-control)] bg-[var(--surface-subtle)] px-3 py-1.5 text-xs text-[var(--text-primary)] font-medium outline-none focus:border-[var(--action)]"
                value={page}
                onChange={(event) => setPage(Number(event.target.value))}
              >
                {Array.from({ length: Math.ceil(slotCount / 16) }, (_, index) => (
                  <option key={index} value={index}>
                    Ô {index * 16 + 1}–{Math.min(slotCount, (index + 1) * 16)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p role="status" className="p-4 text-center text-xs font-mono text-[var(--warning-text)]">
          Không tải được sơ đồ nhánh đấu; vui lòng xem danh sách chi tiết bên dưới.
        </p>
      ) : null}

      <div ref={root} className="w-full overflow-hidden rounded-xl bg-[var(--canvas-deep)] border border-[var(--border-subtle)] shadow-inner" />
    </div>
  );
}
