'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest, errorText } from '../../lib/client';
import { languageLabel, submissionStatusLabel } from '../../lib/labels';
import SourceIde from './SourceIde';

/** Mirror of the server artifact limit (packages/server/src/submissions/artifact-store.ts MAX_ZIP_BYTES). */
const MAX_ZIP_BYTES = 2 * 1024 * 1024;
const MAX_ZIP_LABEL = `${MAX_ZIP_BYTES / (1024 * 1024)} MiB`;

const LANGUAGES = ['PYTHON', 'TYPESCRIPT', 'CPP'] as const;

const ENTRYPOINT_PLACEHOLDER: Record<string, string> = {
  PYTHON: 'main.py',
  TYPESCRIPT: 'index.ts',
  CPP: 'main.cpp',
};

/** MIME types a .zip may carry across platforms; the file name must still end in .zip. */
const ZIP_MIME_TYPES: Record<string, true> = {
  'application/zip': true,
  'application/x-zip-compressed': true,
  'application/x-zip': true,
  'multipart/x-zip': true,
  'application/octet-stream': true,
};

/** Tournament states in which the server accepts submissions (packages/server/src/submissions/service.ts). */
const SUBMISSION_OPEN_STATES: Record<string, true> = {
  REGISTRATION_OPEN: true,
  VALIDATING_SUBMISSIONS: true,
};

/** Non-terminal statuses: only the artifact was accepted, no compile/run receipt exists yet. */
const PENDING_STATUSES: Record<string, true> = {
  PENDING: true,
  VALIDATING: true,
  QUEUED: true,
  COMPILING: true,
  SMOKE_TESTING: true,
};

interface SubmissionRow {
  id: string;
  receiptOrdinal: number | null;
  language: string;
  entrypoint: string;
  sourceDigest: string;
  status: string;
  createdAt: string | null;
}

interface SubmissionReceipt {
  id: string | null;
  receiptOrdinal: number | null;
  sourceDigest: string | null;
  status: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/** The receipt has been observed both flat and nested under `data`; accept either shape. */
function normalizeReceipt(payload: unknown): SubmissionReceipt {
  const top = asRecord(payload) ?? {};
  const nested = asRecord(top.data) ?? {};
  const pick = (keys: string[]): unknown => {
    for (const source of [top, nested]) {
      for (const key of keys) {
        const value = source[key];
        if (value !== undefined && value !== null) return value;
      }
    }
    return null;
  };
  const id = pick(['id', 'receiptId', 'submissionId']);
  const ordinal = pick(['receiptOrdinal', 'receipt_ordinal']);
  const digest = pick(['sourceDigest', 'source_digest']);
  const status = pick(['status']);
  return {
    id: typeof id === 'string' && id.trim() !== '' ? id : null,
    receiptOrdinal: typeof ordinal === 'number' && Number.isFinite(ordinal) ? ordinal : null,
    sourceDigest: typeof digest === 'string' && digest.trim() !== '' ? digest : null,
    status: typeof status === 'string' && status.trim() !== '' ? status : null,
  };
}

function normalizeRow(row: unknown): SubmissionRow | null {
  const record = asRecord(row);
  if (!record) return null;
  const id = typeof record.id === 'string' && record.id.trim() !== '' ? record.id : null;
  if (!id) return null;
  const language = record.language;
  const entrypoint = record.entrypoint;
  const digest = record.sourceDigest ?? record.source_digest;
  const status = record.status;
  const ordinal = record.receiptOrdinal ?? record.receipt_ordinal;
  const createdAt = record.createdAt ?? record.created_at ?? record.receivedAt;
  return {
    id,
    receiptOrdinal: typeof ordinal === 'number' && Number.isFinite(ordinal) ? ordinal : null,
    language: typeof language === 'string' ? language : '',
    entrypoint: typeof entrypoint === 'string' ? entrypoint : '',
    sourceDigest: typeof digest === 'string' ? digest : '',
    status: typeof status === 'string' ? status : '',
    createdAt: typeof createdAt === 'string' && createdAt.trim() !== '' ? createdAt : null,
  };
}

/** Fixed-string transform: identical for every renderer, so it cannot break hydration. */
function formatInstant(iso: string | null): string | null {
  if (!iso) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(iso);
  if (!match) return iso;
  return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]} UTC`;
}

/** Chunked: `String.fromCharCode(...bytes)` blows the call stack on multi-MB files. */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + CHUNK)));
  }
  return btoa(parts.join(''));
}
const zipDrafts = new Map<string, File>();


export default function SubmissionPanel({
  tournamentId,
  teamId,
  tournamentState,
}: {
  tournamentId: string;
  teamId: string;
  tournamentState: string;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Hai đường nộp: tệp .zip có sẵn, hoặc soạn trực tiếp trong trình soạn thảo. */
  const [mode, setMode] = useState<'zip' | 'ide'>('zip');
  const [file, setFile] = useState<File | null>(null);
  const [language, setLanguage] = useState<string>(LANGUAGES[0]);
  const [entrypoint, setEntrypoint] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [receipt, setReceipt] = useState<SubmissionReceipt | null>(null);
  const [history, setHistory] = useState<SubmissionRow[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  /** undefined = not loaded yet, null = no READY submission. */
  const [candidate, setCandidate] = useState<SubmissionRow | null | undefined>(undefined);
  const [candidateError, setCandidateError] = useState<string | null>(null);
  const draftKey = `oantuti:submission-draft:${tournamentId}:${teamId}`;
  const [draftLoaded, setDraftLoaded] = useState(false);
  useEffect(() => {
    setFile(zipDrafts.get(draftKey) ?? null);
    try {
      const raw = sessionStorage.getItem(draftKey);
      if (raw) {
        const draft = JSON.parse(raw) as { mode?: unknown; language?: unknown; entrypoint?: unknown };
        if (draft.mode === 'zip' || draft.mode === 'ide') setMode(draft.mode);
        if (typeof draft.language === 'string') setLanguage(draft.language);
        if (typeof draft.entrypoint === 'string') setEntrypoint(draft.entrypoint);
      }
    } catch { setFormError('Không đọc được bản nháp bài nộp.'); }
    setDraftLoaded(true);
  }, [draftKey]);
  useEffect(() => {
    if (!draftLoaded) return;
    if (file) zipDrafts.set(draftKey, file); else zipDrafts.delete(draftKey);
    try { sessionStorage.setItem(draftKey, JSON.stringify({ mode, language, entrypoint })); }
    catch { setFormError('Không lưu được tùy chọn bài nộp.'); }
  }, [draftLoaded, draftKey, mode, language, entrypoint, file]);

  const loadPanelData = useCallback(async () => {
    const [list, mine] = await Promise.all([
      apiRequest<{ submissions?: unknown[] }>(
        `/api/v2/tournaments/${tournamentId}/submissions?teamId=${encodeURIComponent(teamId)}`
      ),
      apiRequest<{ candidate?: unknown }>(
        `/api/v2/tournaments/${tournamentId}/entries/me?teamId=${encodeURIComponent(teamId)}`
      ),
    ]);
    if (list.ok) {
      const rows = Array.isArray(list.data?.submissions) ? list.data.submissions : [];
      setHistory(rows.map(normalizeRow).filter((row): row is SubmissionRow => row !== null));
      setHistoryError(null);
    } else {
      setHistory(null);
      setHistoryError(errorText(list, 'Không tải được lịch sử nộp bài.'));
    }
    if (mine.ok) {
      setCandidate(mine.data?.candidate ? normalizeRow(mine.data.candidate) : null);
      setCandidateError(null);
    } else {
      setCandidate(undefined);
      setCandidateError(errorText(mine, 'Không tải được bản nộp hiện hành.'));
    }
  }, [tournamentId, teamId]);

  useEffect(() => {
    void loadPanelData();
  }, [loadPanelData]);

  /**
   * Nhận payload receipt thô từ `SourceIde`: chuẩn hoá bằng đúng hàm của đường “Tải .zip” nên
   * phần hiển thị receipt dùng chung, rồi nạp lại lịch sử để thấy kết quả dựng thật của server.
   */
  const onIdeSubmitted = useCallback(
    async (payload: unknown) => {
      setReceipt(normalizeReceipt(payload));
      await loadPanelData();
    },
    [loadPanelData]
  );

  function onFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const picked = event.target.files?.[0] ?? null;
    setReceipt(null);
    const reset = (message: string) => {
      setFile(null);
      setFormError(message);
      if (fileInputRef.current) fileInputRef.current.value = '';
    };
    if (!picked) {
      setFile(null);
      setFormError(null);
      return;
    }
    if (!picked.name.toLowerCase().endsWith('.zip') || (picked.type !== '' && ZIP_MIME_TYPES[picked.type] !== true)) {
      reset('Chỉ nhận tệp .zip chứa mã nguồn bot.');
      return;
    }
    if (picked.size === 0) {
      reset('Tệp .zip rỗng.');
      return;
    }
    if (picked.size > MAX_ZIP_BYTES) {
      reset(`Tệp vượt giới hạn ${MAX_ZIP_LABEL} của server (${picked.size} byte).`);
      return;
    }
    setFile(picked);
    setFormError(null);
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending) return;
    const trimmedEntrypoint = entrypoint.trim();
    if (!file) {
      setFormError('Hãy chọn tệp .zip trước khi nộp.');
      return;
    }
    if (trimmedEntrypoint === '') {
      setFormError('Hãy nhập entrypoint bên trong tệp zip (ví dụ main.py).');
      return;
    }
    setSending(true);
    setFormError(null);
    setReceipt(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await apiRequest<unknown>(`/api/v2/tournaments/${tournamentId}/submissions`, {
        method: 'POST',
        body: {
          teamId,
          language,
          entrypoint: trimmedEntrypoint,
          zipBase64: toBase64(bytes),
        },
      });
      if (!result.ok) {
        setFormError(errorText(result, 'Nộp mã nguồn thất bại.'));
        return;
      }
      setReceipt(normalizeReceipt(result.data));
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      await loadPanelData();
    } catch {
      setFormError('Không đọc được tệp đã chọn.');
    } finally {
      setSending(false);
    }
  }

  const receiptDigest = receipt?.sourceDigest ?? null;
  const receiptStatus = receipt?.status ?? null;
  const submissionOpen = SUBMISSION_OPEN_STATES[tournamentState] === true;

  return (
    <section className="mt-4 min-w-0 rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-3 sm:p-4">
      <h4 className="text-sm font-semibold">Nộp mã nguồn</h4>
      {!submissionOpen ? (
        <p className="mt-1 text-xs text-[var(--warning-text)]">
          Server chỉ nhận bài khi giải ở trạng thái “Đang mở đăng ký” hoặc “Đang kiểm tra bài nộp”; bài nộp lúc này sẽ bị từ chối.
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setMode('zip')}
          aria-pressed={mode === 'zip'}
          className={`h-9 rounded-md px-3 text-xs font-semibold ${
            mode === 'zip'
              ? 'bg-[var(--action)] text-[#0B0D17]'
              : 'border border-[var(--border-control)] text-[var(--text-secondary)]'
          }`}
        >
          Tải .zip
        </button>
        <button
          type="button"
          onClick={() => setMode('ide')}
          aria-pressed={mode === 'ide'}
          className={`h-9 rounded-md px-3 text-xs font-semibold ${
            mode === 'ide'
              ? 'bg-[var(--action)] text-[#0B0D17]'
              : 'border border-[var(--border-control)] text-[var(--text-secondary)]'
          }`}
        >
          Soạn trực tiếp
        </button>
      </div>
      {mode === 'zip' ? (
        <form onSubmit={onSubmit} className="mt-3 flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
              <span className="font-medium text-[var(--text-primary)]">Tệp .zip (tối đa {MAX_ZIP_LABEL})</span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".zip,application/zip"
                onChange={onFileChange}
                className="w-full rounded-md border border-[var(--border-control)] bg-[var(--canvas)] px-3 py-2 text-xs text-[var(--text-primary)] outline-none file:mr-3 file:rounded file:border-0 file:bg-[var(--surface-subtle)] file:px-2 file:py-1 file:text-[var(--text-primary)] focus:border-[var(--accent-secondary)]"
              />
              {file ? <span className="text-xs">Đã chọn: {file.name}. Sau khi tải lại trang, hãy chọn lại tệp ZIP.</span> : null}
            </label>
            <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
              <span className="font-medium text-[var(--text-primary)]">Ngôn ngữ</span>
              <select
                value={language}
                onChange={(event) => setLanguage(event.target.value)}
                className="h-10 rounded-md border border-[var(--border-control)] bg-[var(--canvas)] px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-secondary)]"
              >
                {LANGUAGES.map((value) => (
                  <option key={value} value={value}>
                    {languageLabel[value] ?? value}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
            <span className="font-medium text-[var(--text-primary)]">Entrypoint (đường dẫn trong zip)</span>
            <input
              value={entrypoint}
              onChange={(event) => setEntrypoint(event.target.value)}
              placeholder={ENTRYPOINT_PLACEHOLDER[language] ?? 'main.py'}
              className="h-10 rounded-md border border-[var(--border-control)] bg-[var(--canvas)] px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-secondary)]"
            />
          </label>
          {file ? (
            <p className="text-xs text-[var(--text-secondary)]">
              Đã chọn: <span className="font-mono">{file.name}</span> · {file.size} byte
            </p>
          ) : null}
          {formError ? (
            <p className="rounded-md border border-[var(--danger-text)] px-3 py-2 text-sm text-[var(--danger-text)]">{formError}</p>
          ) : null}
          <div>
            <button
              type="submit"
              disabled={sending || !file || entrypoint.trim() === ''}
              className="h-10 rounded-md bg-[var(--action)] px-4 text-sm font-semibold text-[#0B0D17] disabled:opacity-60"
            >
              {sending ? 'Đang nộp…' : 'Nộp mã nguồn'}
            </button>
          </div>
        </form>
      ) : (
        <SourceIde tournamentId={tournamentId} teamId={teamId} onSubmitted={onIdeSubmitted} />
      )}
      {receipt ? (
        <div className="mt-3 rounded-md border border-[var(--border-subtle)] bg-[var(--canvas)] p-3 text-xs">
          <p className="font-semibold text-[var(--success-text)]">Server đã nhận bài.</p>
          <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2">
            <div className="flex gap-2">
              <dt className="text-[var(--text-secondary)]">Mã receipt:</dt>
              <dd className="font-mono break-all">{receipt.id ?? '—'}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-[var(--text-secondary)]">Số thứ tự:</dt>
              <dd>{receipt.receiptOrdinal ?? '—'}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-[var(--text-secondary)]">Trạng thái:</dt>
              <dd className={receiptStatus === 'REJECTED' ? 'text-[var(--danger-text)]' : undefined}>
                {receiptStatus ? submissionStatusLabel[receiptStatus] ?? receiptStatus : '—'}
              </dd>
            </div>
            <details className="sm:col-span-2"><summary className="cursor-pointer text-[var(--text-secondary)]">Chi tiết mã nguồn</summary><p className="mt-1 break-all font-mono">{receiptDigest ?? '—'}</p></details>
          </dl>
          {receiptStatus !== null && PENDING_STATUSES[receiptStatus] === true ? (
            <p className="mt-2 text-[var(--warning-text)]">
              Đang kiểm tra và biên dịch bài nộp. Tải lại để cập nhật trạng thái.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-3 text-xs">
        <h5 className="text-xs font-semibold text-[var(--text-secondary)]">Bản nộp hiện hành</h5>
        {candidateError ? (
          <p className="mt-1 text-[var(--warning-text)]">{candidateError}</p>
        ) : candidate === undefined ? (
          <p className="mt-1 text-[var(--text-secondary)]">Đang tải…</p>
        ) : candidate === null ? (
          <p className="mt-1 text-[var(--text-secondary)]">Chưa có bản nộp nào ở trạng thái “Sẵn sàng” (READY) cho đội này.</p>
        ) : (
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-mono font-semibold">#{candidate.receiptOrdinal ?? '—'}</span>
            <span>{candidate.language ? languageLabel[candidate.language] ?? candidate.language : '—'}</span>
            <span className="font-mono break-all">{candidate.entrypoint || '—'}</span>
            <span className="rounded-full border border-[var(--border-subtle)] px-2 py-0.5">
              {candidate.status ? submissionStatusLabel[candidate.status] ?? candidate.status : '—'}
            </span>
            <span className="text-[var(--text-secondary)]">{formatInstant(candidate.createdAt) ?? '—'}</span>
            <details><summary className="cursor-pointer text-[var(--text-secondary)]">Chi tiết</summary><span className="break-all font-mono">{candidate.sourceDigest || '—'}</span></details>
          </div>
        )}
      </div>

      <div className="mt-4">
        <h5 className="text-xs font-semibold text-[var(--text-secondary)]">Lịch sử nộp bài</h5>
        {historyError ? (
          <p className="mt-2 text-xs text-[var(--warning-text)]">{historyError}</p>
        ) : history === null ? (
          <p className="mt-2 text-xs text-[var(--text-secondary)]">Đang tải lịch sử…</p>
        ) : history.length === 0 ? (
          <p className="mt-2 text-xs text-[var(--text-secondary)]">Đội này chưa nộp bài nào.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {history.map((row) => {
              const created = formatInstant(row.createdAt);
              const digest = row.sourceDigest
                ? `${row.sourceDigest.slice(0, 16)}${row.sourceDigest.length > 16 ? '…' : ''}`
                : '—';
              return (
                <li
                  key={row.id}
                  className="rounded-sm border border-[var(--border-subtle)] bg-[var(--canvas)] px-3 py-2 text-xs"
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-mono font-semibold">#{row.receiptOrdinal ?? '—'}</span>
                    <span>{row.language ? languageLabel[row.language] ?? row.language : '—'}</span>
                    <span className="font-mono break-all">{row.entrypoint || '—'}</span>
                    <span
                      className={`rounded-full border border-[var(--border-subtle)] px-2 py-0.5${row.status === 'REJECTED' ? ' text-[var(--danger-text)]' : ''}`}
                    >
                      {row.status ? submissionStatusLabel[row.status] ?? row.status : '—'}
                    </span>
                    <span className="text-[var(--text-secondary)]">{created ?? '—'}</span>
                  </div>
                  <details className="mt-1 text-[var(--text-secondary)]"><summary className="cursor-pointer">Chi tiết mã nguồn</summary><p className="break-all font-mono" title={row.sourceDigest || undefined}>{digest}</p></details>
                  {row.status !== '' && PENDING_STATUSES[row.status] === true ? (
                    <p className="mt-1 text-[var(--warning-text)]">
                      Đang kiểm tra và biên dịch bài nộp.
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
