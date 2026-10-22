'use client';

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { BotLanguage, StarterBotTemplateDto } from '@oantuti/protocol';
import { organizerStarterBots, starterBotDownloadUrl } from '../../lib/api';
import { errorText } from '../../lib/client';

interface Notice {
  readonly kind: 'success' | 'error';
  readonly text: string;
}

const DEFAULT_ENTRYPOINTS: Record<BotLanguage, string> = {
  PYTHON: 'main.py',
  TYPESCRIPT: 'bot.ts',
  CPP: 'main.cpp',
};

const LANGUAGE_LABELS: Record<BotLanguage, string> = {
  PYTHON: 'Python',
  TYPESCRIPT: 'TypeScript',
  CPP: 'C++20',
};

const INPUT_CLASS =
  'h-10 rounded-lg border border-[var(--border-control)] bg-[var(--surface-subtle)] px-3 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--action)] transition-colors';
const LABEL_CLASS = 'flex flex-col gap-1.5 text-xs font-medium text-[var(--text-primary)]';
const PRIMARY_BUTTON_CLASS =
  'vct-btn-primary !h-10 !px-5 !text-xs !font-semibold disabled:opacity-60 transition-opacity';
const SECONDARY_BUTTON_CLASS =
  'vct-btn-secondary !h-9 !px-3 !text-xs disabled:opacity-60 transition-opacity';

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const len = bytes.byteLength;
  const chunk = 0x8000;
  for (let i = 0; i < len; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, Math.min(i + chunk, len))));
  }
  return btoa(binary);
}

export default function StarterBotsPanel() {
  const [templates, setTemplates] = useState<StarterBotTemplateDto[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [uploadNotice, setUploadNotice] = useState<Notice | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  // Form states
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [language, setLanguage] = useState<BotLanguage>('PYTHON');
  const [entrypoint, setEntrypoint] = useState(DEFAULT_ENTRYPOINTS.PYTHON);
  const [description, setDescription] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const loadTemplates = useCallback(async () => {
    setLoading(true);
    const result = await organizerStarterBots.list();
    setLoading(false);
    if (!result.ok || !result.data) {
      setNotice({ kind: 'error', text: errorText(result, 'Không tải được danh sách bot mẫu.') });
      return;
    }
    setTemplates(result.data.templates);
  }, []);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  function handleLanguageChange(nextLang: BotLanguage) {
    setLanguage(nextLang);
    // If the entrypoint was the default for the previous language or empty, switch to new default
    if (Object.values(DEFAULT_ENTRYPOINTS).includes(entrypoint) || entrypoint.trim() === '') {
      setEntrypoint(DEFAULT_ENTRYPOINTS[nextLang]);
    }
  }

  async function handleUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setUploadNotice(null);

    const trimmedName = name.trim();
    const trimmedEntrypoint = entrypoint.trim();
    if (!trimmedName || !trimmedEntrypoint) {
      setUploadNotice({ kind: 'error', text: 'Vui lòng nhập tên bot và tệp thực thi (entrypoint).' });
      return;
    }

    if (!selectedFile) {
      setUploadNotice({ kind: 'error', text: 'Vui lòng chọn tệp mã nguồn định dạng .zip.' });
      return;
    }

    if (!selectedFile.name.toLowerCase().endsWith('.zip')) {
      setUploadNotice({ kind: 'error', text: 'Tệp tải lên bắt buộc phải là tệp nén .zip.' });
      return;
    }

    if (selectedFile.size > 2 * 1024 * 1024) {
      setUploadNotice({ kind: 'error', text: 'Kích thước tệp vượt quá giới hạn 2 MiB.' });
      return;
    }

    setPending('upload');
    try {
      const buffer = await selectedFile.arrayBuffer();
      const zipBase64 = arrayBufferToBase64(buffer);

      const result = await organizerStarterBots.create({
        name: trimmedName,
        slug: slug.trim() || undefined,
        language,
        entrypoint: trimmedEntrypoint,
        description: description.trim() || undefined,
        zipBase64,
      });

      setPending(null);
      if (!result.ok) {
        setUploadNotice({ kind: 'error', text: errorText(result, 'Tải lên bot mẫu thất bại.') });
        return;
      }

      setUploadNotice({
        kind: 'success',
        text: `Đã tải lên bot mẫu “${result.data?.template?.name ?? trimmedName}” thành công!`,
      });

      // Reset form
      setName('');
      setSlug('');
      setDescription('');
      setSelectedFile(null);
      setEntrypoint(DEFAULT_ENTRYPOINTS[language]);
      const fileInput = event.currentTarget.querySelector<HTMLInputElement>('input[type="file"]');
      if (fileInput) fileInput.value = '';

      await loadTemplates();
    } catch (err) {
      setPending(null);
      setUploadNotice({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Đã xảy ra lỗi khi đọc tệp.',
      });
    }
  }

  async function handleArchive(template: StarterBotTemplateDto) {
    const confirmed = window.confirm(
      `Lưu trữ bot mẫu “${template.name}”? Sau khi lưu trữ, thí sinh sẽ không nhìn thấy bot này trong danh sách tải về nữa.`
    );
    if (!confirmed) return;

    setPending(`archive-${template.id}`);
    const result = await organizerStarterBots.archive(template.id);
    setPending(null);
    if (!result.ok) {
      setNotice({ kind: 'error', text: errorText(result, 'Lưu trữ bot mẫu thất bại.') });
      return;
    }

    setNotice({ kind: 'success', text: `Đã lưu trữ bot mẫu “${template.name}”.` });
    await loadTemplates();
  }

  return (
    <div className="flex flex-col gap-6">
      {notice && (
        <div
          role="alert"
          className={`rounded-lg border px-4 py-3 text-xs font-medium ${
            notice.kind === 'error'
              ? 'border-[var(--danger-text)] text-[var(--danger-text)] bg-[rgba(239,68,68,0.06)]'
              : 'border-[var(--success-text)] text-[var(--success-text)] bg-[rgba(16,185,129,0.06)]'
          }`}
        >
          {notice.text}
        </div>
      )}

      {/* Upload Form */}
      <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] p-5 shadow-sm">
        <div className="mb-4">
          <h4 className="text-sm font-bold text-[var(--text-primary)]">Tải lên bot mẫu mới</h4>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            Cung cấp mã nguồn bot mẫu định dạng ZIP (tối đa 2 MiB) để thí sinh tải về chạy thử nghiệm local hoặc tham khảo.
          </p>
        </div>

        <form onSubmit={handleUpload} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className={LABEL_CLASS}>
              <span>Tên bot mẫu <span className="text-[var(--danger-text)]">*</span></span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="vd: Starter Bot Python (Random)"
                required
                className={INPUT_CLASS}
              />
            </label>

            <label className={LABEL_CLASS}>
              <span>Slug (tùy chọn)</span>
              <input
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="vd: python-random-starter"
                className={INPUT_CLASS}
              />
            </label>

            <label className={LABEL_CLASS}>
              <span>Ngôn ngữ lập trình <span className="text-[var(--danger-text)]">*</span></span>
              <select
                value={language}
                onChange={(e) => handleLanguageChange(e.target.value as BotLanguage)}
                className={INPUT_CLASS}
              >
                <option value="PYTHON">Python</option>
                <option value="TYPESCRIPT">TypeScript</option>
                <option value="CPP">C++20</option>
              </select>
            </label>

            <label className={LABEL_CLASS}>
              <span>Tệp thực thi chính (Entrypoint) <span className="text-[var(--danger-text)]">*</span></span>
              <input
                value={entrypoint}
                onChange={(e) => setEntrypoint(e.target.value)}
                placeholder="vd: main.py"
                required
                className={INPUT_CLASS}
              />
            </label>
          </div>

          <label className={LABEL_CLASS}>
            <span>Mô tả ngắn gọn</span>
            <textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="vd: Bot mẫu cơ bản đọc trạng thái bàn cờ từ stdin và trả về nước đi ngẫu nhiên..."
              className="w-full rounded-lg border border-[var(--border-control)] bg-[var(--surface-subtle)] p-2.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--action)] transition-colors"
            />
          </label>

          <label className={LABEL_CLASS}>
            <span>Tệp mã nguồn (.zip) <span className="text-[var(--danger-text)]">*</span></span>
            <input
              type="file"
              accept=".zip"
              onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
              required
              className="block w-full text-xs text-[var(--text-secondary)] file:mr-3 file:rounded-md file:border-0 file:bg-[var(--action)] file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-[var(--action-text)] hover:file:opacity-90"
            />
          </label>

          {uploadNotice && (
            <div
              role="alert"
              className={`rounded-lg border px-3 py-2 text-xs font-medium ${
                uploadNotice.kind === 'error'
                  ? 'border-[var(--danger-text)] text-[var(--danger-text)] bg-[rgba(239,68,68,0.06)]'
                  : 'border-[var(--success-text)] text-[var(--success-text)] bg-[rgba(16,185,129,0.06)]'
              }`}
            >
              {uploadNotice.text}
            </div>
          )}

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={pending === 'upload'}
              className={PRIMARY_BUTTON_CLASS}
            >
              {pending === 'upload' ? 'Đang tải lên…' : 'Tải lên bot mẫu'}
            </button>
          </div>
        </form>
      </div>

      {/* Templates List */}
      <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] pb-3">
          <div>
            <h4 className="text-sm font-bold text-[var(--text-primary)]">Thư viện bot mẫu</h4>
            <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
              Các bot mẫu đang hoạt động hiển thị cho thí sinh ở tab Bot mẫu của giải.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadTemplates()}
            disabled={loading}
            className={SECONDARY_BUTTON_CLASS}
          >
            {loading ? 'Đang tải…' : 'Làm mới'}
          </button>
        </div>

        {loading && !templates ? (
          <p className="py-6 text-center text-xs text-[var(--text-secondary)]">Đang tải danh sách bot mẫu…</p>
        ) : !templates || templates.length === 0 ? (
          <p className="py-6 text-center text-xs text-[var(--text-secondary)]">
            Chưa có bot mẫu nào được tải lên. Hãy dùng biểu mẫu phía trên để thêm bot đầu tiên.
          </p>
        ) : (
          <div className="mt-3 divide-y divide-[var(--border-subtle)]">
            {templates.map((tpl) => (
              <div key={tpl.id} className="flex flex-wrap items-start justify-between gap-4 py-3.5">
                <div className="flex flex-col gap-1 min-w-[240px] flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-xs text-[var(--text-primary)]">{tpl.name}</span>
                    <span className="rounded-full border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-2 py-0.5 font-mono text-[10px] text-[var(--text-secondary)]">
                      {LANGUAGE_LABELS[tpl.language] ?? tpl.language}
                    </span>
                    <span className="font-mono text-[10px] text-[var(--text-secondary)]">
                      v{tpl.version}
                    </span>
                    {tpl.isActive ? (
                      <span className="rounded-full bg-[rgba(16,185,129,0.12)] px-2 py-0.5 text-[10px] font-semibold text-[var(--success-text)]">
                        Đang hoạt động
                      </span>
                    ) : (
                      <span className="rounded-full bg-[var(--surface-subtle)] px-2 py-0.5 text-[10px] text-[var(--text-secondary)]">
                        Đã lưu trữ
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-3 font-mono text-[11px] text-[var(--text-secondary)]">
                    <span>Entrypoint: <strong className="text-[var(--text-primary)]">{tpl.entrypoint}</strong></span>
                    <span>Slug: {tpl.slug}</span>
                    <span>Digest: {tpl.sourceDigest ? `${tpl.sourceDigest.slice(0, 12)}…` : '—'}</span>
                  </div>

                  {tpl.description && (
                    <p className="text-xs text-[var(--text-secondary)] line-clamp-2 mt-0.5">
                      {tpl.description}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <a
                    href={starterBotDownloadUrl(tpl.id)}
                    download
                    className={SECONDARY_BUTTON_CLASS + ' inline-flex items-center gap-1'}
                  >
                    Tải về (.zip)
                  </a>
                  {tpl.isActive && (
                    <button
                      type="button"
                      disabled={pending === `archive-${tpl.id}`}
                      onClick={() => void handleArchive(tpl)}
                      className="h-9 rounded-md border border-[var(--danger-text)] px-3 text-xs font-medium text-[var(--danger-text)] hover:bg-[rgba(239,68,68,0.06)] disabled:opacity-60 transition-colors"
                    >
                      {pending === `archive-${tpl.id}` ? 'Đang lưu trữ…' : 'Lưu trữ'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Local Testing Guide Box */}
      <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)] p-4 text-xs text-[var(--text-secondary)]">
        <h5 className="font-semibold text-[var(--text-primary)]">Hướng dẫn chạy kiểm thử Bot cục bộ (Local Match)</h5>
        <p className="mt-1">
          Sau khi tải gói bot mẫu về và giải nén, thí sinh có thể chạy thử nghiệm đối đầu trực tiếp trên máy bằng CLI:
        </p>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-[var(--canvas)] p-2.5 font-mono text-[11px] text-[var(--action)]">
          npm run match:play -- --white &lt;đường_dẫn_bot_1&gt; --black &lt;đường_dẫn_bot_2&gt;
        </pre>
      </div>
    </div>
  );
}
