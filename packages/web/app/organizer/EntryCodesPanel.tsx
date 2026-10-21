'use client';

import { useCallback, useEffect, useState } from 'react';

import { createEntryCode, listEntryCodes, onlineTeams, type CreatedEntryCode, type EntryCodeSummary } from '../../lib/api';
import { errorText } from '../../lib/client';

interface Notice {
  readonly kind: 'success' | 'error';
  readonly text: string;
}

const INPUT_CLASS =
  'h-9 rounded-md border border-[var(--border-control)] bg-[var(--canvas)] px-3 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent-secondary)]';
const BUTTON_CLASS =
  'h-9 rounded-md border border-[var(--border-control)] px-3 text-xs font-semibold disabled:opacity-60';

function formatInstant(iso: string | null): string {
  if (!iso) return '—';
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(iso);
  return match ? `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]} UTC` : iso;
}

function isCodeExhausted(entry: EntryCodeSummary): boolean {
  return entry.uses >= entry.maxUses;
}

function isCodeExpired(entry: EntryCodeSummary): boolean {
  return entry.expiresAt !== null && new Date(entry.expiresAt).getTime() <= Date.now();
}

/**
 * Shared entry codes (ONLINE profile only): a lecturer hands one code to many students, each captain
 * admits their own team with it. The plaintext code exists only in the creation response, so it is
 * shown once with an explicit copy action; the list keeps counts and expiry, never the code.
 */
export default function EntryCodesPanel({ tournamentId }: { readonly tournamentId: string }) {
  const [open, setOpen] = useState(false);
  const [codes, setCodes] = useState<readonly EntryCodeSummary[] | null>(null);
  const [maxUses, setMaxUses] = useState('20');
  const [expiresAt, setExpiresAt] = useState('');
  const [created, setCreated] = useState<CreatedEntryCode | null>(null);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const load = useCallback(async () => {
    setPending('load');
    const result = await listEntryCodes(tournamentId);
    setPending(null);
    if (!result.ok) {
      setNotice({ kind: 'error', text: errorText(result, 'Không đọc được danh sách mã vào giải.') });
      return;
    }
    setCodes(result.data ?? []);
  }, [tournamentId]);

  useEffect(() => {
    if (open && codes === null) void load();
  }, [open, codes, load]);

  async function submit() {
    const parsedMaxUses = Number(maxUses);
    if (!Number.isInteger(parsedMaxUses) || parsedMaxUses < 1) {
      setNotice({ kind: 'error', text: 'Số lượt dùng phải là số nguyên ≥ 1.' });
      return;
    }
    const expiry = expiresAt === '' ? null : new Date(expiresAt);
    if (expiry !== null && Number.isNaN(expiry.getTime())) {
      setNotice({ kind: 'error', text: 'Hạn dùng không hợp lệ.' });
      return;
    }
    setPending('create');
    const result = await createEntryCode(tournamentId, {
      maxUses: parsedMaxUses,
      expiresAt: expiry ? expiry.toISOString() : null,
    });
    setPending(null);
    if (!result.ok || !result.data) {
      setNotice({ kind: 'error', text: errorText(result, 'Tạo mã vào giải thất bại.') });
      return;
    }
    setCreated(result.data);
    setCopied(false);
    setNotice({
      kind: 'success',
      text: `Đã tạo mã dùng tối đa ${result.data.maxUses} lượt${result.data.expiresAt ? `, hết hạn ${formatInstant(result.data.expiresAt)}` : ''}.`,
    });
    setCodes(null);
    await load();
  }

  async function copyCode() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.code);
      setCopied(true);
    } catch {
      setNotice({ kind: 'error', text: 'Trình duyệt không cho sao chép — hãy chọn mã và copy thủ công.' });
    }
  }

  return (
    <div className="min-w-0 rounded-md border border-[var(--border-subtle)] bg-[var(--canvas)] px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-[var(--text-secondary)]">Mã vào giải dùng chung (ONLINE)</p>
          <p className="mt-1 text-[11px] text-[var(--text-secondary)]">
            Mỗi đội trưởng tự thêm đội của mình bằng mã này; mã chỉ hiển thị một lần khi tạo.
          </p>
        </div>
        <button type="button" onClick={() => setOpen((current) => !current)} className={BUTTON_CLASS}>
          {open ? 'Ẩn mã vào giải' : 'Mã vào giải'}
        </button>
      </div>

      {open ? (
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-[11px] text-[var(--text-secondary)]">
              <span>Số lượt dùng</span>
              <input
                type="number"
                min={1}
                value={maxUses}
                onChange={(event) => setMaxUses(event.target.value)}
                className={`${INPUT_CLASS} w-28`}
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-[var(--text-secondary)]">
              <span>Hết hạn (tuỳ chọn)</span>
              <input
                type="datetime-local"
                value={expiresAt}
                onChange={(event) => setExpiresAt(event.target.value)}
                className={INPUT_CLASS}
              />
            </label>
            <button type="button" disabled={pending !== null} onClick={() => void submit()} className={BUTTON_CLASS}>
              {pending === 'create' ? 'Đang tạo…' : 'Tạo mã'}
            </button>
            <button type="button" disabled={pending !== null} onClick={() => void load()} className={BUTTON_CLASS}>
              {pending === 'load' ? 'Đang tải…' : 'Tải lại danh sách'}
            </button>
          </div>

          {created ? (
            <div className="rounded-md border border-[var(--accent-secondary)] px-3 py-2">
              <p className="text-[11px] text-[var(--text-secondary)]">
                Mã vừa tạo (chỉ hiện một lần — hãy gửi cho các đội trưởng ngay):
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-3">
                <code className="break-all rounded-sm bg-[var(--surface)] px-3 py-2 font-mono text-sm font-semibold tracking-wider text-[var(--text-primary)]">
                  {created.code}
                </code>
                <button type="button" onClick={() => void copyCode()} className={BUTTON_CLASS}>
                  {copied ? 'Đã sao chép' : 'Sao chép'}
                </button>
              </div>
            </div>
          ) : null}

          {notice ? (
            <p
              className={
                notice.kind === 'error'
                  ? 'rounded-md border border-[var(--danger-text)] px-3 py-2 text-xs text-[var(--danger-text)]'
                  : 'rounded-md border border-[var(--success-text)] px-3 py-2 text-xs text-[var(--success-text)]'
              }
            >
              {notice.text}
            </p>
          ) : null}

          {codes === null ? (
            <p className="text-xs text-[var(--text-secondary)]">Chưa có dữ liệu mã.</p>
          ) : codes.length === 0 ? (
            <p className="text-xs text-[var(--text-secondary)]">Giải này chưa có mã vào giải nào.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
              {codes.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-center gap-3">
                  <span className="font-mono">…{entry.id.slice(0, 8)}</span>
                  <span className="tabular-nums">
                    {entry.uses}/{entry.maxUses} lượt
                  </span>
                  <span>hết hạn {formatInstant(entry.expiresAt)}</span>
                  <span>tạo {formatInstant(entry.createdAt)}</span>
                  {isCodeExhausted(entry) ? <span className="text-[var(--warning-text)]">đã hết lượt</span> : null}
                  {isCodeExpired(entry) ? <span className="text-[var(--warning-text)]">đã hết hạn</span> : null}
                  <button type="button" disabled={pending !== null} onClick={() => { if (!window.confirm('Xoay mã này? Mã cũ sẽ ngừng nhận lượt mới; các lượt đã ghi danh vẫn giữ nguyên.')) return; setPending(entry.id); void onlineTeams.rotateCode(tournamentId, entry.id, { maxUses: entry.maxUses }).then(result => { setPending(null); if (!result.ok || !result.data) { setNotice({ kind: 'error', text: errorText(result, 'Không thể xoay mã.') }); return; } setCreated(result.data); setCopied(false); setNotice({ kind: 'success', text: 'Mã đã xoay; mã mới chỉ hiển thị lần này.' }); setCodes(null); void load(); }); }} className={BUTTON_CLASS}>Xoay mã</button>
                  <button type="button" disabled={pending !== null} onClick={() => { if (!window.confirm('Thu hồi mã này? Các lượt ghi danh hiện có vẫn được giữ.')) return; setPending(entry.id); void onlineTeams.revokeCode(tournamentId, entry.id).then(result => { setPending(null); if (!result.ok) { setNotice({ kind: 'error', text: errorText(result, 'Không thể thu hồi mã.') }); return; } setNotice({ kind: 'success', text: 'Đã thu hồi mã; các lượt ghi danh hiện có vẫn được giữ.' }); setCodes(null); void load(); }); }} className={BUTTON_CLASS}>Thu hồi</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
