'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  applyCorrection,
  disqualifyTeam,
  fetchAcceptedResult,
  fetchBracketGames,
  fetchDisputes,
  previewCorrection,
  reauth,
  resolveDispute,
  setAppealWindow,
  type BracketGameOption,
  type CorrectionCommandInput,
  type CorrectionPreview,
  type CorrectionReceipt,
  type DisputeRecord,
} from '../../lib/api';
import { adjudicationErrorText, errorText, reauthErrorText, REAUTH_PROMPT_TEXT } from '../../lib/client';
import {
  correctionActionLabel,
  disputeResolutionLabel,
  disputeStatusLabel,
  encounterStatusLabel,
  stageLabel,
} from '../../lib/labels';

/** The server's accepted minute range for an appeal window (0–10080 = 7 days). */
const MAX_APPEAL_MINUTES = 10080;
const DEFAULT_APPEAL_MINUTES = '1440';

/** Statuses that still block `finalize`; resolving them is the point of this panel. */
const OPEN_STATUSES: Record<string, true> = { OPEN: true, UNDER_REVIEW: true };

const statusTone: Record<string, string> = {
  OPEN: 'border-[var(--warning-text)] text-[var(--warning-text)]',
  UNDER_REVIEW: 'border-[var(--accent-secondary)] text-[var(--accent-secondary)]',
  RESOLVED: 'border-[var(--success-text)] text-[var(--success-text)]',
  REJECTED: 'border-[var(--danger-text)] text-[var(--danger-text)]',
};

const INPUT_CLASS =
  'h-10 w-full min-w-0 rounded-md border border-[var(--border-control)] bg-[var(--canvas)] px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-secondary)]';
const LABEL_CLASS = 'flex min-w-0 flex-col gap-1 text-xs text-[var(--text-secondary)]';
const PRIMARY_BUTTON_CLASS =
  'h-10 rounded-md bg-[var(--action)] px-4 text-sm font-semibold text-[var(--action-text)] disabled:opacity-60';
const SECONDARY_BUTTON_CLASS =
  'h-10 rounded-md border border-[var(--border-control)] px-3 text-xs font-semibold disabled:opacity-60';

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

function toneClass(notice: Notice | null): string | null {
  if (!notice) return null;
  return notice.kind === 'error'
    ? 'rounded-md border border-[var(--danger-text)] px-3 py-2 text-xs text-[var(--danger-text)]'
    : 'rounded-md border border-[var(--success-text)] px-3 py-2 text-xs text-[var(--success-text)]';
}

/**
 * A guarded action the API refused with 403 `REAUTH_REQUIRED` (migration 016): this session must
 * confirm the operator's password. The command is snapshotted at refusal time so the replay after a
 * successful confirmation sends exactly what was refused — not whatever the form holds by then.
 */
type ReauthRetry =
  | { readonly kind: 'appeal-window'; readonly minutes: number }
  | {
      readonly kind: 'disqualify';
      readonly teamId: string;
      readonly reason: string;
      readonly stage: string;
    }
  | {
      readonly kind: 'apply-correction';
      readonly gameId: string;
      readonly command: CorrectionCommandInput;
      readonly previewDigest: string;
    };

/** Password box that resumes one guarded action; the refusal reason stays in the caller's notice. */
function ReauthPrompt({
  password,
  busy,
  onPassword,
  onConfirm,
}: {
  password: string;
  busy: boolean;
  onPassword: (value: string) => void;
  onConfirm: () => void;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-end gap-3 rounded-md border border-[var(--warning-text)] px-3 py-2">
      <label className={LABEL_CLASS}>
        <span className="font-medium text-[var(--warning-text)]">{REAUTH_PROMPT_TEXT}</span>
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => onPassword(event.target.value)}
          className={INPUT_CLASS}
        />
      </label>
      <button type="button" disabled={busy} onClick={onConfirm} className={PRIMARY_BUTTON_CLASS}>
        {busy ? 'Đang xác nhận…' : 'Xác nhận'}
      </button>
    </div>
  );
}

export default function TournamentAdjudication({
  tournamentId,
  state,
}: {
  tournamentId: string;
  state: string;
}) {
  const router = useRouter();
  const [disputes, setDisputes] = useState<DisputeRecord[] | null>(null);
  const [games, setGames] = useState<BracketGameOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [disputeNotice, setDisputeNotice] = useState<Notice | null>(null);
  const [appealNotice, setAppealNotice] = useState<Notice | null>(null);
  const [correctionNotice, setCorrectionNotice] = useState<Notice | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [appealMinutes, setAppealMinutes] = useState(DEFAULT_APPEAL_MINUTES);
  const [savedAppealMinutes, setSavedAppealMinutes] = useState<number | null>(null);
  const [gameId, setGameId] = useState('');
  const [action, setAction] = useState<CorrectionCommandInput['action']>('VOID');
  const [reason, setReason] = useState('');
  const [expectedRevision, setExpectedRevision] = useState('');
  const [preview, setPreview] = useState<CorrectionPreview | null>(null);
  const [receipt, setReceipt] = useState<CorrectionReceipt | null>(null);
  const [reauthRetry, setReauthRetry] = useState<ReauthRetry | null>(null);
  const [reauthPassword, setReauthPassword] = useState('');
  const [dqTeamId, setDqTeamId] = useState('');
  const [dqReason, setDqReason] = useState('');
  const [dqStage, setDqStage] = useState('MAIN');
  const [dqNotice, setDqNotice] = useState<Notice | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [disputeList, bracket] = await Promise.all([fetchDisputes(tournamentId), fetchBracketGames(tournamentId)]);
    setLoading(false);
    if (!disputeList.ok) {
      setDisputes(null);
      setLoadError(errorText(disputeList, 'Không tải được danh sách tranh chấp.'));
      return;
    }
    if (!bracket.ok) {
      setGames(null);
      setLoadError(errorText(bracket, 'Không tải được nhánh đấu.'));
      return;
    }
    setDisputes(disputeList.data ?? []);
    setGames(bracket.data ?? []);
    setLoadError(null);
  }, [tournamentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const command: CorrectionCommandInput = { action, reason: reason.trim(), expectedRevision: Number(expectedRevision) };

  async function resolve(dispute: DisputeRecord, decision: 'RESOLVED' | 'REJECTED') {
    setPending(`${dispute.id}:${decision}`);
    const result = await resolveDispute(dispute.id, decision, notes[dispute.id] ?? '');
    setPending(null);
    if (!result.ok) {
      setDisputeNotice({ kind: 'error', text: errorText(result, 'Xử lý tranh chấp thất bại.') });
      return;
    }
    setDisputeNotice({
      kind: 'success',
      text: `Đã ghi nhận ${disputeResolutionLabel[decision] ?? decision} cho tranh chấp ${dispute.id}.`,
    });
    setNotes((current) => {
      const next = { ...current };
      delete next[dispute.id];
      return next;
    });
    await load();
    router.refresh();
  }

  async function saveAppealWindow() {
    const minutes = Number(appealMinutes.trim());
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_APPEAL_MINUTES) {
      setAppealNotice({
        kind: 'error',
        text: `Số phút phải là số nguyên từ 0 đến ${MAX_APPEAL_MINUTES} (7 ngày).`,
      });
      return;
    }
    await submitAppealWindow(minutes);
  }

  /** The guarded write itself, shared by the button and by the replay after a password confirmation. */
  async function submitAppealWindow(minutes: number) {
    setPending('appeal-window');
    const result = await setAppealWindow(tournamentId, minutes);
    setPending(null);
    if (!result.ok) {
      if (result.code === 'REAUTH_REQUIRED') {
        setReauthRetry({ kind: 'appeal-window', minutes });
        setAppealNotice(null);
        return;
      }
      setAppealNotice({ kind: 'error', text: adjudicationErrorText(result, 'Đặt cửa sổ kháng nghị thất bại.') });
      return;
    }
    const saved = result.data?.finalAppealWindowMinutes ?? minutes;
    setSavedAppealMinutes(saved);
    setAppealNotice({
      kind: 'success',
      text: `Cửa sổ kháng nghị đã được lưu: ${saved} phút. Trong thời gian này server vẫn chặn chốt kết quả (APPEAL_WINDOW_OPEN).`,
    });
    router.refresh();
  }

  async function pickGame(nextGameId: string) {
    setGameId(nextGameId);
    setPreview(null);
    setReceipt(null);
    if (nextGameId === '') return;
    setPending('game-result');
    const result = await fetchAcceptedResult(nextGameId);
    setPending(null);
    if (!result.ok) {
      setExpectedRevision('');
      setCorrectionNotice({
        kind: 'error',
        text: `${errorText(result, 'Không đọc được kết quả của ván.')}${
          result.status === 404 ? ' — ván chưa có kết quả được chấp nhận nên chưa sửa được.' : ''
        }`,
      });
      return;
    }
    setExpectedRevision(String(result.data?.revision ?? 1));
    setCorrectionNotice(null);
  }

  async function runPreview() {
    if (gameId === '') {
      setCorrectionNotice({ kind: 'error', text: 'Hãy chọn ván cần sửa.' });
      return;
    }
    if (command.reason === '') {
      setCorrectionNotice({ kind: 'error', text: 'Hãy nhập lý do sửa kết quả.' });
      return;
    }
    if (!Number.isInteger(command.expectedRevision) || command.expectedRevision < 1) {
      setCorrectionNotice({ kind: 'error', text: 'Bản kết quả hiện tại (expectedRevision) phải là số nguyên dương.' });
      return;
    }
    setPending('preview');
    const result = await previewCorrection(gameId, command);
    setPending(null);
    setReceipt(null);
    if (!result.ok) {
      setPreview(null);
      setCorrectionNotice({ kind: 'error', text: errorText(result, 'Tạo bản xem trước thất bại.') });
      return;
    }
    setPreview(result.data);
    setCorrectionNotice({ kind: 'success', text: 'Đã tạo bản xem trước. Kiểm tra tác động rồi bấm áp dụng.' });
  }

  async function runApply() {
    if (!preview) {
      setCorrectionNotice({ kind: 'error', text: 'Hãy tạo bản xem trước trước khi áp dụng.' });
      return;
    }
    await submitCorrection(preview.gameId, command, preview.previewDigest);
  }

  /** The guarded write itself, shared by the button and by the replay after a password confirmation. */
  async function submitCorrection(
    targetGameId: string,
    submitCommand: CorrectionCommandInput,
    previewDigest: string
  ) {
    setPending('apply');
    const result = await applyCorrection(targetGameId, submitCommand, previewDigest);
    setPending(null);
    if (!result.ok) {
      if (result.code === 'REAUTH_REQUIRED') {
        setReauthRetry({
          kind: 'apply-correction',
          gameId: targetGameId,
          command: submitCommand,
          previewDigest,
        });
        setCorrectionNotice(null);
        return;
      }
      setCorrectionNotice({ kind: 'error', text: errorText(result, 'Áp dụng sửa kết quả thất bại.') });
      return;
    }
    setReceipt(result.data);
    setPreview(null);
    setReason('');
    setCorrectionNotice({
      kind: 'success',
      text: `Đã áp dụng. Bản kết quả mới: ${result.data?.newRevision ?? '—'} cho ván ${result.data?.gameId ?? targetGameId}.`,
    });
    await load();
    const refreshed = await fetchAcceptedResult(targetGameId);
    if (refreshed.ok) setExpectedRevision(String(refreshed.data?.revision ?? ''));
    router.refresh();
  }

  /**
   * Disqualification (02-GAMEPLAY §124): the ruling voids every encounter of the team in the stage
   * and rebuilds the schedule from the earliest affected round. A confirmation is required because
   * voiding results is irreversible from this panel.
   */
  async function runDisqualification() {
    const teamId = dqTeamId.trim();
    const reason = dqReason.trim();
    if (teamId === '' || reason.length < 3) {
      setDqNotice({ kind: 'error', text: 'Cần teamId và lý do công khai (ít nhất 3 ký tự).' });
      return;
    }
    const confirmed = window.confirm(
      'Loại đội này khỏi giải? Toàn bộ cặp đấu của đội trong stage sẽ bị hủy, giải sẽ tạm dừng và lịch đấu được dựng lại từ vòng sớm nhất.'
    );
    if (!confirmed) return;
    await submitDisqualification(teamId, reason, dqStage);
  }

  /** The guarded write itself, shared by the button and by the replay after a password confirmation. */
  async function submitDisqualification(teamId: string, reason: string, stage: string) {
    setPending('disqualify');
    const result = await disqualifyTeam(tournamentId, teamId, { reason, stage });
    setPending(null);
    if (!result.ok) {
      if (result.code === 'REAUTH_REQUIRED') {
        setReauthRetry({ kind: 'disqualify', teamId, reason, stage });
        setDqNotice(null);
        return;
      }
      setDqNotice({ kind: 'error', text: errorText(result, 'Loại đội thất bại.') });
      return;
    }
    setDqNotice({
      kind: 'success',
      text: `Đã loại đội ${teamId}: hủy ${result.data?.voidedEncounters ?? 0} cặp đấu${
        (result.data?.invalidatedDownstream ?? 0) > 0 ? `, dựng lại ${result.data?.invalidatedDownstream} cặp phía sau` : ''
      }${result.data?.paused ? ', giải đang tạm dừng' : ''}.`,
    });
    setDqTeamId('');
    setDqReason('');
    await load();
    router.refresh();
  }

  /**
   * Confirms the password and replays the refused guarded action exactly once. A refused confirmation
   * replays nothing and reports why — the panel must never show a result that did not happen.
   */
  async function confirmReauth() {
    const retry = reauthRetry;
    if (!retry) return;
    if (reauthPassword === '') {
      const text = 'Nhập mật khẩu để xác nhận lại.';
      if (retry.kind === 'appeal-window') setAppealNotice({ kind: 'error', text });
      else if (retry.kind === 'disqualify') setDqNotice({ kind: 'error', text });
      else setCorrectionNotice({ kind: 'error', text });
      return;
    }
    setPending('reauth');
    const result = await reauth(reauthPassword);
    setPending(null);
    if (!result.ok) {
      const text = reauthErrorText(result);
      if (retry.kind === 'appeal-window') setAppealNotice({ kind: 'error', text });
      else if (retry.kind === 'disqualify') setDqNotice({ kind: 'error', text });
      else setCorrectionNotice({ kind: 'error', text });
      return;
    }
    setReauthPassword('');
    setReauthRetry(null);
    if (retry.kind === 'appeal-window') await submitAppealWindow(retry.minutes);
    else if (retry.kind === 'disqualify') await submitDisqualification(retry.teamId, retry.reason, retry.stage);
    else await submitCorrection(retry.gameId, retry.command, retry.previewDigest);
  }

  const rows = disputes ?? [];
  const gameRows = games ?? [];
  const openCount = rows.filter((dispute) => OPEN_STATUSES[dispute.status] === true).length;

  return (
    <section className="min-w-0 rounded-md border border-[var(--border-subtle)] bg-[var(--canvas)] p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold">Tranh chấp</h4>
          <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
            {disputes === null
              ? 'Không đọc được danh sách tranh chấp.'
              : `${rows.length} tranh chấp · ${openCount} đang chặn chốt kết quả`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className={SECONDARY_BUTTON_CLASS}
        >
          {loading ? 'Đang tải…' : 'Tải lại dữ liệu'}
        </button>
      </div>

      {loadError ? (
        <p className="mt-3 rounded-md border border-[var(--warning-text)] px-3 py-2 text-xs text-[var(--warning-text)]">
          {loadError}
        </p>
      ) : null}

      {disputes === null ? null : rows.length === 0 ? (
        <p className="mt-3 text-xs text-[var(--text-secondary)]">Chưa có tranh chấp nào cho giải này.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {rows.map((dispute) => {
            const encounter = gameRows.find((game) => game.encounterId === dispute.encounterId) ?? null;
            const isOpen = OPEN_STATUSES[dispute.status] === true;
            return (
              <li key={dispute.id} className="min-w-0 rounded-sm border border-[var(--border-subtle)] bg-[var(--surface)] p-3 text-xs">
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
                    <span className="text-[var(--text-secondary)]">Gửi lúc {formatInstant(dispute.createdAt)}</span>
                  </span>
                  <span className="font-mono text-[var(--text-secondary)]" title={dispute.id}>
                    #{dispute.id.slice(0, 8)}
                  </span>
                </div>
                <p className="mt-2 text-[var(--text-secondary)]">
                  {encounter ? (
                    <>
                      Ván {encounter.gameOrdinal} · {stageLabel[encounter.stage] ?? encounter.stage} vòng{' '}
                      {encounter.roundOrdinal} · ô #{encounter.slotOrdinal} · {encounter.teamAName ?? 'Đội chưa đặt tên'} –{' '}
                      {encounter.teamBName ?? 'Bye — miễn đấu'} · trận{' '}
                      {encounterStatusLabel[encounter.encounterStatus] ?? encounter.encounterStatus}
                    </>
                  ) : (
                    <>
                      Trận <span className="font-mono">{dispute.encounterId}</span>
                    </>
                  )}
                  {' · đội '}
                  <span className="font-mono">{dispute.teamId}</span>
                </p>
                <p className="mt-2 whitespace-pre-wrap text-[var(--text-primary)]">Lý do: {dispute.reason}</p>
                {dispute.decision ? (
                  <p className="mt-1 text-[var(--accent-secondary)]">Phản hồi đã ghi: {dispute.decision}</p>
                ) : null}
                {dispute.resolvedAt ? (
                  <p className="mt-1 text-[var(--text-secondary)]">Xử lý lúc {formatInstant(dispute.resolvedAt)}</p>
                ) : null}

                {isOpen ? (
                  <div className="mt-3 flex flex-col gap-2 border-t border-[var(--border-subtle)] pt-3">
                    <label className={LABEL_CLASS}>
                      <span className="font-medium text-[var(--text-primary)]">Ghi chú quyết định</span>
                      <input
                        value={notes[dispute.id] ?? ''}
                        onChange={(event) => setNotes((current) => ({ ...current, [dispute.id]: event.target.value }))}
                        placeholder="Ví dụ: chấp nhận, chạy lại ván 2 với cùng bản đồ"
                        className={INPUT_CLASS}
                      />
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={pending !== null}
                        onClick={() => void resolve(dispute, 'RESOLVED')}
                        className={PRIMARY_BUTTON_CLASS}
                      >
                        {pending === `${dispute.id}:RESOLVED` ? 'Đang lưu…' : (disputeResolutionLabel.RESOLVED ?? 'RESOLVED')}
                      </button>
                      <button
                        type="button"
                        disabled={pending !== null}
                        onClick={() => void resolve(dispute, 'REJECTED')}
                        className={SECONDARY_BUTTON_CLASS}
                      >
                        {pending === `${dispute.id}:REJECTED` ? 'Đang lưu…' : (disputeResolutionLabel.REJECTED ?? 'REJECTED')}
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {disputeNotice ? <p className={`mt-3 ${toneClass(disputeNotice)}`}>{disputeNotice.text}</p> : null}

      {state === 'PROVISIONAL' ? (
        <div className="mt-4 border-t border-[var(--border-subtle)] pt-4">
          <h4 className="text-sm font-bold">Cửa sổ kháng nghị</h4>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            Giải đang ở trạng thái kết quả tạm tính. Trong lúc cửa sổ kháng nghị còn mở, server trả{' '}
            <span className="font-mono">APPEAL_WINDOW_OPEN</span> và chặn chốt kết quả; tranh chấp đang mở còn trả{' '}
            <span className="font-mono">OPEN_DISPUTES_BLOCK_FINALIZATION</span>.
          </p>
          <div className="mt-2 flex flex-wrap items-end gap-3">
            <label className={LABEL_CLASS}>
              <span className="font-medium text-[var(--text-primary)]">Số phút (0–{MAX_APPEAL_MINUTES})</span>
              <input
                type="number"
                min={0}
                max={MAX_APPEAL_MINUTES}
                step={1}
                value={appealMinutes}
                onChange={(event) => setAppealMinutes(event.target.value)}
                className={INPUT_CLASS}
              />
            </label>
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => void saveAppealWindow()}
              className={PRIMARY_BUTTON_CLASS}
            >
              {pending === 'appeal-window' ? 'Đang lưu…' : 'Lưu cửa sổ kháng nghị'}
            </button>
            {savedAppealMinutes === null ? null : (
              <span className="text-xs text-[var(--text-secondary)]">
                Đã lưu cho giải này: <span className="font-semibold">{savedAppealMinutes}</span> phút
              </span>
            )}
          </div>
          {appealNotice ? <p className={`mt-3 ${toneClass(appealNotice)}`}>{appealNotice.text}</p> : null}
          {reauthRetry?.kind === 'appeal-window' ? (
            <ReauthPrompt
              password={reauthPassword}
              busy={pending !== null}
              onPassword={setReauthPassword}
              onConfirm={() => void confirmReauth()}
            />
          ) : null}
        </div>
      ) : null}

      <div className="mt-4 border-t border-[var(--border-subtle)] pt-4">
        <h4 className="text-sm font-bold">Sửa kết quả ván</h4>
        <p className="mt-1 text-xs text-[var(--text-secondary)]">
          Luôn xem trước rồi mới áp dụng: server gắn <span className="font-mono">previewDigest</span> vào bản xem trước và từ chối
          áp dụng nếu bản xem trước đã cũ.
        </p>
        {gameRows.length === 0 ? (
          <p className="mt-2 text-xs text-[var(--text-secondary)]">
            {games === null ? 'Đang tải nhánh đấu…' : 'Giải chưa có ván nào trong nhánh đấu.'}
          </p>
        ) : (
          <div className="mt-2 flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className={LABEL_CLASS}>
                <span className="font-medium text-[var(--text-primary)]">Ván</span>
                <select value={gameId} onChange={(event) => void pickGame(event.target.value)} className={INPUT_CLASS}>
                  <option value="">— Chọn ván —</option>
                  {gameRows.map((game) => (
                    <option key={game.gameId} value={game.gameId}>
                      {`Ván ${game.gameOrdinal} · ${stageLabel[game.stage] ?? game.stage} vòng ${game.roundOrdinal} · ô #${game.slotOrdinal} · ${game.teamAName ?? 'Đội chưa đặt tên'} – ${game.teamBName ?? 'Bye — miễn đấu'} (${game.status})`}
                    </option>
                  ))}
                </select>
              </label>
              <label className={LABEL_CLASS}>
                <span className="font-medium text-[var(--text-primary)]">Hành động</span>
                <select
                  value={action}
                  onChange={(event) => {
                    setAction(event.target.value === 'REJUDGE' ? 'REJUDGE' : 'VOID');
                    setPreview(null);
                  }}
                  className={INPUT_CLASS}
                >
                  {(['VOID', 'REJUDGE'] as const).map((value) => (
                    <option key={value} value={value}>
                      {correctionActionLabel[value] ?? value}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className={LABEL_CLASS}>
                <span className="font-medium text-[var(--text-primary)]">Bản kết quả hiện tại (expectedRevision)</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={expectedRevision}
                  onChange={(event) => {
                    setExpectedRevision(event.target.value);
                    setPreview(null);
                  }}
                  placeholder={pending === 'game-result' ? 'Đang đọc…' : '1'}
                  className={INPUT_CLASS}
                />
              </label>
              <label className={LABEL_CLASS}>
                <span className="font-medium text-[var(--text-primary)]">Lý do sửa</span>
                <input
                  value={reason}
                  onChange={(event) => {
                    setReason(event.target.value);
                    setPreview(null);
                  }}
                  placeholder="Ví dụ: ván bị treo do lỗi sandbox, cần hủy kết quả"
                  className={INPUT_CLASS}
                />
              </label>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={pending !== null}
                onClick={() => void runPreview()}
                className={SECONDARY_BUTTON_CLASS}
              >
                {pending === 'preview' ? 'Đang xem trước…' : 'Xem trước'}
              </button>
              <button
                type="button"
                disabled={pending !== null || !preview}
                onClick={() => void runApply()}
                className={PRIMARY_BUTTON_CLASS}
              >
                {pending === 'apply' ? 'Đang áp dụng…' : 'Áp dụng sửa kết quả'}
              </button>
            </div>

            {preview ? (
              <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--canvas)] p-3 text-xs">
                <p className="font-semibold text-[var(--accent-secondary)]">Bản xem trước tác động</p>
                <p className="mt-1 text-[var(--text-primary)]">{preview.description}</p>
                <p className="mt-2 text-[var(--text-secondary)]">
                  Encounters phụ thuộc: {preview.descendantEncounterIds.length}; vòng ảnh hưởng: {preview.affectedRounds.map(round => `${round.stage}/${round.roundOrdinal}`).join(', ') || '—'};
                  {' '}ghép cặp lại: {preview.requiredRePair ? 'có' : 'không'}; dựng lại standings: {preview.requiredRebuild ? 'có' : 'không'};
                  {' '}rating events bị thu hồi: {preview.ratingEventCount}.
                </p>
                <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2">
                  <div className="flex gap-2">
                    <dt className="text-[var(--text-secondary)]">Ván:</dt>
                    <dd className="font-mono break-all">{preview.gameId}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-[var(--text-secondary)]">Bản hiện tại:</dt>
                    <dd>{preview.currentRevision}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-[var(--text-secondary)]">Hành động:</dt>
                    <dd>{correctionActionLabel[preview.action] ?? preview.action}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-[var(--text-secondary)]">previewDigest:</dt>
                    <dd className="font-mono break-all">{preview.previewDigest}</dd>
                  </div>
                </dl>
              </div>
            ) : null}

            {receipt ? (
              <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--canvas)] p-3 text-xs">
                <p className="font-semibold text-[var(--success-text)]">Đã áp dụng sửa kết quả</p>
                <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2">
                  <div className="flex gap-2">
                    <dt className="text-[var(--text-secondary)]">Mã receipt:</dt>
                    <dd className="font-mono break-all">{receipt.receiptId ?? '—'}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-[var(--text-secondary)]">Bản mới:</dt>
                    <dd>{receipt.newRevision ?? '—'}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-[var(--text-secondary)]">Ván:</dt>
                    <dd className="font-mono break-all">{receipt.gameId ?? '—'}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-[var(--text-secondary)]">Áp dụng lúc:</dt>
                    <dd>{formatInstant(receipt.appliedAt)}</dd>
                  </div>
                </dl>
              </div>
            ) : null}
          </div>
        )}
        {correctionNotice ? <p className={`mt-3 ${toneClass(correctionNotice)}`}>{correctionNotice.text}</p> : null}
        {reauthRetry?.kind === 'apply-correction' ? (
          <ReauthPrompt
            password={reauthPassword}
            busy={pending !== null}
            onPassword={setReauthPassword}
            onConfirm={() => void confirmReauth()}
          />
        ) : null}
        <div className="mt-6 rounded-md border border-[var(--danger-text)] px-4 py-3">
          <h3 className="text-sm font-bold text-[var(--danger-text)]">Loại đội (DQ)</h3>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            Dành cho quyết định gian lận đã được duyệt: hủy toàn bộ cặp đấu của đội trong stage, tạm dừng giải và
            dựng lại lịch từ vòng sớm nhất. Không giữ lại một phần kết quả nào của đội đó.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className={`${LABEL_CLASS} min-w-[180px] flex-1`}>
              <span>teamId</span>
              <input
                value={dqTeamId}
                onChange={(event) => setDqTeamId(event.target.value)}
                placeholder="team_…"
                className={`${INPUT_CLASS} font-mono`}
              />
            </label>
            <label className={`${LABEL_CLASS} w-[150px]`}>
              <span>Stage</span>
              <select value={dqStage} onChange={(event) => setDqStage(event.target.value)} className={INPUT_CLASS}>
                <option value="MAIN">Vòng chính</option>
                <option value="PLAYOFF">Playoff</option>
              </select>
            </label>
            <label className={`${LABEL_CLASS} min-w-[240px] flex-[2]`}>
              <span>Lý do công khai (3–500 ký tự)</span>
              <input
                value={dqReason}
                onChange={(event) => setDqReason(event.target.value)}
                placeholder="Ví dụ: gian lận trong vòng 1, hội đồng đã xác nhận"
                className={INPUT_CLASS}
              />
            </label>
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => void runDisqualification()}
              className={PRIMARY_BUTTON_CLASS}
            >
              {pending === 'disqualify' ? 'Đang xử lý…' : 'Loại đội'}
            </button>
          </div>
          {dqNotice ? <p className={`mt-3 ${toneClass(dqNotice)}`}>{dqNotice.text}</p> : null}
          {reauthRetry?.kind === 'disqualify' ? (
            <ReauthPrompt
              password={reauthPassword}
              busy={pending !== null}
              onPassword={setReauthPassword}
              onConfirm={() => void confirmReauth()}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}
