'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import ReplayViewer from '../replays/ReplayViewer';
import {
  createPrivateTest,
  listPrivateTests,
  normalizePrivateTestReceipt,
  privateTestReplayUrl,
  type PrivateTestReceipt,
  type PrivateTestSummary,
} from '../../lib/api';
import { errorText } from '../../lib/client';
import { languageLabel, privateTestStatusLabel, privateTestWinnerLabel } from '../../lib/labels';

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

/** Statuses the runner has not finished yet; the list only changes when it is reloaded by hand. */
const IN_PROGRESS_STATUSES: Record<string, true> = {
  QUEUED: true,
  COMPILING: true,
  SMOKE_TESTING: true,
  RUNNING: true,
};

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

/**
 * Renders exactly what the API sent for a run: the played-match facts, its error text, or nothing.
 * A test whose `result` is absent never gets an invented verdict.
 */
function PrivateTestOutcomeView({ test }: { test: PrivateTestSummary }) {
  const result = test.result;
  if (result?.kind === 'played') {
    const { winner, reason, totalTurns, opponent, map, finishedAt } = result.outcome;
    const finished = formatInstant(finishedAt);
    return (
      <dl className="mt-2 grid gap-x-4 gap-y-1 border-t border-[var(--border-subtle)] pt-2 sm:grid-cols-2">
        <div className="flex gap-2">
          <dt className="text-[var(--text-secondary)]">Bên thắng:</dt>
          <dd className="font-semibold text-[var(--success-text)]">
            {privateTestWinnerLabel[winner] ?? winner}
          </dd>
        </div>
        {reason ? (
          <div className="flex gap-2">
            <dt className="text-[var(--text-secondary)]">Lý do:</dt>
            <dd>{reason}</dd>
          </div>
        ) : null}
        <div className="flex gap-2">
          <dt className="text-[var(--text-secondary)]">Số lượt:</dt>
          <dd>{totalTurns}</dd>
        </div>
        {opponent && (opponent.label !== '' || opponent.kind !== '') ? (
          <div className="flex gap-2">
            <dt className="text-[var(--text-secondary)]">Đối thủ:</dt>
            <dd>
              {opponent.label || opponent.kind}
              {opponent.submissionId ? (
                <span className="font-mono"> · {opponent.submissionId.slice(0, 8)}…</span>
              ) : null}
            </dd>
          </div>
        ) : null}
        {map && map.name !== '' ? (
          <div className="flex gap-2">
            <dt className="text-[var(--text-secondary)]">Bàn:</dt>
            <dd>
              {map.name}
              {map.version !== null ? ` v${map.version}` : ''}
              {map.source !== '' ? ` · ${map.source}` : ''}
            </dd>
          </div>
        ) : null}
        {finished ? (
          <div className="flex gap-2">
            <dt className="text-[var(--text-secondary)]">Kết thúc:</dt>
            <dd>{finished}</dd>
          </div>
        ) : null}
      </dl>
    );
  }
  if (test.status === 'COMPLETED' && result === null) {
    return (
      <p className="mt-2 text-[var(--text-secondary)]">
        Đang chạy trận… bấm “Tải lại” sau vài giây để xem kết quả.
      </p>
    );
  }
  if (result?.kind === 'error') {
    return (
      <p className="mt-2 break-words rounded-md border border-[var(--danger-text)] px-2 py-1 text-[var(--danger-text)]">
        {result.error}
      </p>
    );
  }
  if (test.status === 'FAILED') {
    return (
      <p className="mt-2 break-words text-[var(--warning-text)]">
        {test.buildError ?? 'API không trả về chi tiết lỗi cho lần chạy này.'}
      </p>
    );
  }
  return null;
}

const testZipDrafts = new Map<string, File>();

export default function PrivateTestPanel({
  tournamentId,
  teamId,
}: {
  tournamentId: string;
  teamId: string;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [inputMode, setInputMode] = useState<'zip' | 'ide'>('zip');
  const [language, setLanguage] = useState<string>(LANGUAGES[0]);
  const [entrypoint, setEntrypoint] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [receipt, setReceipt] = useState<PrivateTestReceipt | null>(null);
  const [tests, setTests] = useState<PrivateTestSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [viewingTestId, setViewingTestId] = useState<string | null>(null);
  const draftKey = `oantuti:test-draft:${tournamentId}:${teamId}`;
  const [draftLoaded, setDraftLoaded] = useState(false);
  useEffect(() => {
    setFile(testZipDrafts.get(draftKey) ?? null);
    try {
      const raw = sessionStorage.getItem(draftKey);
      if (raw) {
        const draft = JSON.parse(raw) as { language?: unknown; entrypoint?: unknown };
        if (typeof draft.language === 'string') setLanguage(draft.language);
        if (typeof draft.entrypoint === 'string') setEntrypoint(draft.entrypoint);
      }
    } catch { setFormError('Không đọc được bản nháp test riêng tư.'); }
    setDraftLoaded(true);
  }, [draftKey]);
  useEffect(() => {
    if (!draftLoaded) return;
    if (file) testZipDrafts.set(draftKey, file); else testZipDrafts.delete(draftKey);
    try { sessionStorage.setItem(draftKey, JSON.stringify({ language, entrypoint })); }
    catch { setFormError('Không lưu được tùy chọn test riêng tư.'); }
  }, [draftLoaded, draftKey, language, entrypoint, file]);

  const loadTests = useCallback(async () => {
    setLoading(true);
    const result = await listPrivateTests(tournamentId, teamId);
    if (result.ok) {
      setTests(result.data ?? []);
      setListError(null);
    } else {
      setTests(null);
      setListError(errorText(result, 'Không tải được danh sách test riêng tư.'));
    }
    setLoading(false);
  }, [tournamentId, teamId]);

  useEffect(() => {
    void loadTests();
  }, [loadTests]);

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
      setFormError('Hãy chọn tệp .zip trước khi chạy test.');
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
      const result = await createPrivateTest(tournamentId, {
        teamId,
        language,
        entrypoint: trimmedEntrypoint,
        zipBase64: toBase64(bytes),
      });
      if (!result.ok) {
        setFormError(errorText(result, 'Tạo test riêng tư thất bại.'));
        return;
      }
      setReceipt(result.data);
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      await loadTests();
    } catch {
      setFormError('Không đọc được tệp đã chọn.');
    } finally {
      setSending(false);
    }
  }

  const receiptDigest = receipt?.sourceDigest ?? null;

  return (
    <section className="mt-3 min-w-0 rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">Test riêng tư</h4>
        <button
          type="button"
          onClick={() => void loadTests()}
          disabled={loading}
          className="rounded-md border border-[var(--border-control)] px-3 py-1 text-xs font-medium hover:border-[var(--action)] disabled:opacity-60"
        >
          {loading ? 'Đang tải…' : 'Tải lại'}
        </button>
      </div>
      <p className="mt-1 text-xs text-[var(--text-secondary)]">
        Test riêng tư chỉ chạy bản sao của bot để bạn xem trước.{' '}
        <span className="font-semibold text-[var(--warning-text)]">
          Kết quả test riêng tư không ảnh hưởng đến kết quả chính thức của giải
        </span>{' '}
        (không tính điểm, không xếp hạng, không tạo receipt chính thức).
      </p>
      <div className="mt-3 flex items-center gap-2 border-b border-[var(--border-subtle)] pb-2">
        <button
          type="button"
          onClick={() => setInputMode('zip')}
          className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
            inputMode === 'zip'
              ? 'bg-[var(--surface-subtle)] text-[var(--action)]'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
          }`}
        >
          Tải file .zip
        </button>
        <button
          type="button"
          onClick={() => setInputMode('ide')}
          className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
            inputMode === 'ide'
              ? 'bg-[var(--surface-subtle)] text-[var(--action)]'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
          }`}
        >
          Soạn mã trực tiếp (IDE)
        </button>
      </div>

      {inputMode === 'zip' ? (
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
            className="vct-btn-primary !py-2.5 !px-5 !text-xs !rounded-xl disabled:opacity-60 cursor-pointer"
          >
            {sending ? 'Đang gửi test...' : 'Chạy test riêng tư'}
          </button>
        </div>
      </form>
      ) : (
        <SourceIde
          tournamentId={tournamentId}
          teamId={teamId}
          mode="test"
          submitButtonText="Chạy test từ trình soạn thảo"
          onSubmitArchive={async (archive) => {
            const res = await createPrivateTest(tournamentId, {
              teamId,
              language: archive.language,
              entrypoint: archive.entrypoint,
              zipBase64: archive.zipBase64,
            });
            return { ok: res.ok, message: res.message ?? undefined, data: res.data };
          }}
          onSubmitted={(data) => {
            setReceipt(normalizePrivateTestReceipt(data));
            void loadTests();
          }}
        />
      )}

      {receipt ? (
        <div className="mt-3 rounded-md border border-[var(--border-subtle)] bg-[var(--canvas)] p-3 text-xs">
          <p className="font-semibold text-[var(--success-text)]">Server đã nhận yêu cầu test riêng tư.</p>
          <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2">
            <div className="flex gap-2">
              <dt className="text-[var(--text-secondary)]">Mã test:</dt>
              <dd className="font-mono break-all">{receipt.testId ?? '—'}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-[var(--text-secondary)]">Trạng thái:</dt>
              <dd>{receipt.status ? privateTestStatusLabel[receipt.status] ?? receipt.status : '—'}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-[var(--text-secondary)]">Xếp hàng lúc:</dt>
              <dd>{formatInstant(receipt.queuedAt ?? receipt.timestamp) ?? '—'}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-[var(--text-secondary)]">Digest nguồn:</dt>
              <dd className="font-mono break-all" title={receiptDigest ?? undefined}>
                {receiptDigest ? `${receiptDigest.slice(0, 16)}${receiptDigest.length > 16 ? '…' : ''}` : '—'}
              </dd>
            </div>
          </dl>
        </div>
      ) : null}

      <div className="mt-3 text-xs">
        <h5 className="text-xs font-semibold text-[var(--text-secondary)]">Test của đội này</h5>
        {listError ? (
          <p className="mt-2 text-[var(--warning-text)]">{listError}</p>
        ) : tests === null ? (
          <p className="mt-2 text-[var(--text-secondary)]">Đang tải…</p>
        ) : tests.length === 0 ? (
          <p className="mt-2 text-[var(--text-secondary)]">Đội này chưa chạy test riêng tư nào.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {tests.map((test) => (
              <li
                key={test.id}
                className="rounded-sm border border-[var(--border-subtle)] bg-[var(--canvas)] px-3 py-2 text-xs"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span
                    className={`rounded-full border border-[var(--border-subtle)] px-2 py-0.5${test.status === 'FAILED' ? ' text-[var(--danger-text)]' : ''}`}
                  >
                    {test.status ? privateTestStatusLabel[test.status] ?? test.status : '—'}
                  </span>
                  <span>{test.language ? languageLabel[test.language] ?? test.language : '—'}</span>
                  <span className="font-mono break-all">{test.entrypoint || '—'}</span>
                  <span className="text-[var(--text-secondary)]">{formatInstant(test.createdAt) ?? '—'}</span>
                  <span className="font-mono text-[var(--text-secondary)]" title={test.sourceDigest || undefined}>
                    digest:{' '}
                    {test.sourceDigest
                      ? `${test.sourceDigest.slice(0, 16)}${test.sourceDigest.length > 16 ? '…' : ''}`
                      : '—'}
                  </span>
                  <span className="font-mono text-[var(--text-secondary)]" title={test.id}>
                    #{test.id.slice(0, 8)}
                  </span>
                  {test.replayDigest ? (
                    <>
                      <a
                        href={privateTestReplayUrl(test.id)}
                        download
                        className="font-semibold text-[var(--action)] underline"
                      >
                        Tải replay
                      </a>
                      <button type="button" onClick={() => setViewingTestId(viewingTestId === test.id ? null : test.id)} className="font-semibold text-[var(--action)] underline">
                        {viewingTestId === test.id ? 'Đóng bàn cờ' : 'Xem bàn cờ'}
                      </button>
                    </>
                  ) : null}
                </div>
                {test.status !== '' && IN_PROGRESS_STATUSES[test.status] === true ? (
                  <p className="mt-1 text-[var(--warning-text)]">
                    Đang chạy… bấm “Tải lại” để cập nhật trạng thái và kết quả.
                  </p>
                ) : null}
                <PrivateTestOutcomeView test={test} />
                {viewingTestId === test.id && test.replayDigest ? <ReplayViewer gameId={null} digest={test.replayDigest} replayEndpoint={privateTestReplayUrl(test.id)} /> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
