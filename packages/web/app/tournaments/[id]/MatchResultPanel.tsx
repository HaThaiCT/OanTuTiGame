'use client';

import { useRef, useState } from 'react';
import { apiRequest } from '../../../lib/client';
import { describePublicGameResult, normalizePublicGameResult, type PublicGameResult } from '../../../lib/public-game-result';

export const matchResultPanelLabel = describePublicGameResult;

export default function MatchResultPanel({ gameId }: { readonly gameId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<PublicGameResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function toggle() {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (result || inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    try {
      const response = await apiRequest<unknown>(`/api/v2/games/${encodeURIComponent(gameId)}/result`);
      if (!response.ok) {
        setError(response.message ?? `Không tải được kết quả trận (HTTP ${response.status}).`);
        return;
      }
      const normalized = normalizePublicGameResult(response.data);
      if (!normalized) { setError('Phản hồi kết quả trận không hợp lệ.'); return; }
      setResult(normalized);
    } catch {
      setError('Không tải được kết quả trận.');
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }

  const description = result ? describePublicGameResult(result) : null;
  return (
    <div className="flex flex-col gap-2">
      <button type="button" aria-expanded={open} onClick={() => void toggle()} className="text-left text-[var(--action)] underline underline-offset-2">
        {open ? 'Đóng kết quả' : 'Kết quả'}
      </button>
      {open ? (
        <div className="min-w-56 rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-3 text-xs" role="region" aria-label="Kết quả trận đấu">
          {loading ? <p role="status">Đang tải kết quả…</p> : null}
          {error ? <p role="alert" className="text-[var(--danger-text)]">{error}</p> : null}
          {result && description ? (
            <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
              <div><dt className="text-[var(--text-secondary)]">Kết quả</dt><dd className="font-semibold">{description.winner}</dd></div>
              <div><dt className="text-[var(--text-secondary)]">Lý do</dt><dd>{description.reason}</dd></div>
              <div><dt className="text-[var(--text-secondary)]">Tổng số lượt</dt><dd>{result.totalTurns}</dd></div>
              <div><dt className="text-[var(--text-secondary)]">Trạng thái kết quả</dt><dd>{description.disposition}</dd></div>
              {result.revision !== null ? <div><dt className="text-[var(--text-secondary)]">Phiên bản</dt><dd>{result.revision}</dd></div> : null}
            </dl>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
