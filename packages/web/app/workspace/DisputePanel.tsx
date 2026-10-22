'use client';

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  createDispute,
  fetchBracketGames,
  fetchDisputes,
  type BracketGameOption,
  type DisputeRecord,
} from '../../lib/api';
import { errorText } from '../../lib/client';
import { disputeStatusLabel, encounterStatusLabel, stageLabel } from '../../lib/labels';

/**
 * States in which the server accepts a dispute (`DisputeService.createDispute`):
 * a RUNNING tournament still has matches left, a PROVISIONAL one is inside its appeal window.
 */
const DISPUTABLE_STATES: Record<string, true> = { RUNNING: true, PROVISIONAL: true };

/** Statuses that still block finalization, so they are highlighted for the team. */
const OPEN_STATUSES: Record<string, true> = { OPEN: true, UNDER_REVIEW: true };

const statusTone: Record<string, string> = {
  OPEN: 'border-[var(--warning-text)] text-[var(--warning-text)]',
  UNDER_REVIEW: 'border-[var(--accent-secondary)] text-[var(--accent-secondary)]',
  RESOLVED: 'border-[var(--success-text)] text-[var(--success-text)]',
  REJECTED: 'border-[var(--danger-text)] text-[var(--danger-text)]',
};

interface Notice {
  readonly kind: 'success' | 'error';
  readonly text: string;
}

/** Fixed-string transform: identical for every renderer, so it cannot break hydration. */
function formatInstant(iso: string | null): string {
  if (!iso) return '—';
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(iso);
  if (!match) return iso;
  return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]} UTC`;
}

function gameOptionLabel(game: BracketGameOption): string {
  const teams = `${game.teamAName ?? 'Đội chưa đặt tên'} – ${game.teamBName ?? 'Bye — miễn đấu'}`;
  return `Ván ${game.gameOrdinal} · ${stageLabel[game.stage] ?? game.stage} vòng ${game.roundOrdinal} · ô #${game.slotOrdinal} · ${teams}`;
}

export default function DisputePanel({
  tournamentId,
  teamId,
  tournamentState,
}: {
  tournamentId: string;
  teamId: string;
  tournamentState: string;
}) {
  const [games, setGames] = useState<BracketGameOption[] | null>(null);
  const [disputes, setDisputes] = useState<DisputeRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selectedGameId, setSelectedGameId] = useState('');
  const [reason, setReason] = useState('');
  const draftKey = `oantuti:appeal-draft:${tournamentId}:${teamId}`;
  const [draftLoaded, setDraftLoaded] = useState(false);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(draftKey);
      if (raw) {
        const draft = JSON.parse(raw) as { gameId?: unknown; reason?: unknown };
        if (typeof draft.gameId === 'string') setSelectedGameId(draft.gameId);
        if (typeof draft.reason === 'string') setReason(draft.reason);
      }
    } catch {
      setNotice({ kind: 'error', text: 'Không đọc được bản nháp kháng nghị.' });
    }
    setDraftLoaded(true);
  }, [draftKey]);
  useEffect(() => {
    if (!draftLoaded) return;
    try { sessionStorage.setItem(draftKey, JSON.stringify({ gameId: selectedGameId, reason })); }
    catch { setNotice({ kind: 'error', text: 'Không lưu được bản nháp kháng nghị.' }); }
  }, [draftLoaded, draftKey, selectedGameId, reason]);

  const load = useCallback(async () => {
    setLoading(true);
    const [bracket, disputeList] = await Promise.all([
      fetchBracketGames(tournamentId),
      fetchDisputes(tournamentId),
    ]);
    setLoading(false);
    if (!bracket.ok) {
      setGames(null);
      setLoadError(errorText(bracket, 'Không tải được nhánh đấu của giải.'));
      return;
    }
    if (!disputeList.ok) {
      setDisputes(null);
      setLoadError(errorText(disputeList, 'Không tải được danh sách tranh chấp.'));
      return;
    }
    setGames((bracket.data ?? []).filter((game) => game.teamAId === teamId || game.teamBId === teamId));
    // The API returns every team's disputes; the workspace only shows this team's.
    setDisputes((disputeList.data ?? []).filter((dispute) => dispute.teamId === teamId));
    setLoadError(null);
  }, [tournamentId, teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const selected = (games ?? []).find((game) => game.gameId === selectedGameId) ?? null;
    if (!selected) {
      setNotice({ kind: 'error', text: 'Hãy chọn một ván của đội trong nhánh đấu.' });
      return;
    }
    if (reason.trim() === '') {
      setNotice({ kind: 'error', text: 'Hãy nhập lý do tranh chấp để ban tổ chức xem xét.' });
      return;
    }
    setSending(true);
    const result = await createDispute(tournamentId, {
      encounterId: selected.encounterId,
      teamId,
      reason: reason.trim(),
    });
    setSending(false);
    if (!result.ok) {
      setNotice({ kind: 'error', text: errorText(result, 'Gửi tranh chấp thất bại.') });
      return;
    }
    setNotice({
      kind: 'success',
      text: `Đã gửi tranh chấp${result.data ? ` (mã ${result.data.id})` : ''}. Ban tổ chức sẽ xử lý và trạng thái hiện bên dưới.`,
    });
    setReason('');
    setSelectedGameId('');
    await load();
  }

  const canDispute = DISPUTABLE_STATES[tournamentState] === true;
  const gameRows = games ?? [];

  return (
    <section className="mt-3 min-w-0 rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">Tranh chấp &amp; kháng nghị</h4>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="rounded-md border border-[var(--border-control)] px-3 py-1 text-xs font-medium hover:border-[var(--action)] disabled:opacity-60"
        >
          {loading ? 'Đang tải…' : 'Tải lại'}
        </button>
      </div>
      <p className="mt-1 text-xs text-[var(--text-secondary)]">
        Khi vòng đấu cuối kết thúc, giải chuyển sang <span className="font-semibold">Kết quả tạm tính (PROVISIONAL)</span> và
        mở cửa sổ kháng nghị do ban tổ chức đặt cho giải. Chỉ khi mọi tranh chấp đang mở được xử lý, ban tổ chức mới chốt được{' '}
        <span className="font-semibold">Kết quả chính thức (FINALIZED)</span>, nên hãy gửi tranh chấp sớm. Kết quả và bảng xếp
        hạng luôn do server quyết định — khối này không tạo hay sửa kết quả.
      </p>

      {loadError ? (
        <p className="mt-3 rounded-md border border-[var(--warning-text)] px-3 py-2 text-xs text-[var(--warning-text)]">
          {loadError}
        </p>
      ) : null}

      {canDispute ? (
        gameRows.length === 0 ? (
          <p className="mt-3 text-xs text-[var(--text-secondary)]">
            {games === null
              ? 'Đang tải nhánh đấu…'
              : 'Chưa có ván nào của đội trong nhánh đấu, nên chưa thể gửi tranh chấp.'}
          </p>
        ) : (
          <form onSubmit={submit} className="mt-3 flex flex-col gap-3">
            <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--text-secondary)]">
              <span className="font-medium text-[var(--text-primary)]">Ván của đội</span>
              <select
                value={selectedGameId}
                onChange={(event) => setSelectedGameId(event.target.value)}
                className="h-10 w-full min-w-0 rounded-md border border-[var(--border-control)] bg-[var(--canvas)] px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-secondary)]"
              >
                <option value="">— Chọn ván —</option>
                {gameRows.map((game) => (
                  <option key={game.gameId} value={game.gameId}>
                    {gameOptionLabel(game)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--text-secondary)]">
              <span className="font-medium text-[var(--text-primary)]">Lý do tranh chấp</span>
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={3}
                placeholder="Ví dụ: ván 2 bị treo ở lượt 40, bot của đội không nhận được hành động hợp lệ."
                className="w-full min-w-0 rounded-md border border-[var(--border-control)] bg-[var(--canvas)] p-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-secondary)]"
              />
            </label>
            {notice ? (
              <p
                className={`rounded-md border px-3 py-2 text-xs ${
                  notice.kind === 'error'
                    ? 'border-[var(--danger-text)] text-[var(--danger-text)]'
                    : 'border-[var(--success-text)] text-[var(--success-text)]'
                }`}
              >
                {notice.text}
              </p>
            ) : null}
            <div>
              <button
                type="submit"
                disabled={sending}
                className="h-10 rounded-md bg-[var(--action)] px-4 text-sm font-semibold text-[var(--action-text)] disabled:opacity-60"
              >
                {sending ? 'Đang gửi…' : 'Gửi tranh chấp'}
              </button>
            </div>
          </form>
        )
      ) : (
        <p className="mt-3 text-xs text-[var(--text-secondary)]">
          Chỉ gửi được tranh chấp khi giải đang diễn ra (RUNNING) hoặc ở trạng thái kết quả tạm tính (PROVISIONAL). Giải này hiện
          ở trạng thái <span className="font-mono">{tournamentState}</span>.
        </p>
      )}

      <div className="mt-4">
        <p className="text-xs font-semibold text-[var(--text-secondary)]">
          Tranh chấp của đội{disputes === null ? '' : ` (${disputes.length})`}
        </p>
        {disputes === null ? (
          <p className="mt-2 text-xs text-[var(--text-secondary)]">Không đọc được danh sách tranh chấp.</p>
        ) : disputes.length === 0 ? (
          <p className="mt-2 text-xs text-[var(--text-secondary)]">Đội chưa gửi tranh chấp nào.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {disputes.map((dispute) => {
              const encounter = gameRows.find((game) => game.encounterId === dispute.encounterId) ?? null;
              return (
                <li
                  key={dispute.id}
                  className="rounded-md border border-[var(--border-subtle)] bg-[var(--canvas)] p-3 text-xs"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded-full border px-2 py-0.5 font-semibold ${
                          statusTone[dispute.status] ?? 'border-[var(--border-subtle)] text-[var(--text-secondary)]'
                        }`}
                      >
                        {disputeStatusLabel[dispute.status] ?? dispute.status}
                      </span>
                      <span className="font-mono text-[var(--text-secondary)]">{dispute.status}</span>
                      {OPEN_STATUSES[dispute.status] === true ? (
                        <span className="text-[var(--warning-text)]">đang chặn chốt kết quả</span>
                      ) : null}
                    </span>
                    <span className="text-[var(--text-secondary)]">Gửi lúc {formatInstant(dispute.createdAt)}</span>
                  </div>
                  <p className="mt-2 text-[var(--text-secondary)]">
                    {encounter ? (
                      <>
                        Ván {encounter.gameOrdinal} · {stageLabel[encounter.stage] ?? encounter.stage} vòng{' '}
                        {encounter.roundOrdinal} · ô #{encounter.slotOrdinal} ·{' '}
                        {encounter.teamAName ?? 'Đội chưa đặt tên'} – {encounter.teamBName ?? 'Bye — miễn đấu'} · trận{' '}
                        {encounterStatusLabel[encounter.encounterStatus] ?? encounter.encounterStatus}
                      </>
                    ) : (
                      <>
                        Trận <span className="font-mono">{dispute.encounterId}</span>
                      </>
                    )}
                  </p>
                  <p className="mt-2 whitespace-pre-wrap text-[var(--text-primary)]">Lý do: {dispute.reason}</p>
                  {dispute.decision ? (
                    <p className="mt-1 text-[var(--accent-secondary)]">Phản hồi của ban tổ chức: {dispute.decision}</p>
                  ) : null}
                  {dispute.resolvedAt ? (
                    <p className="mt-1 text-[var(--text-secondary)]">Xử lý lúc {formatInstant(dispute.resolvedAt)}</p>
                  ) : null}
                  <p className="mt-1 font-mono text-[var(--text-secondary)]">mã: {dispute.id}</p>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
