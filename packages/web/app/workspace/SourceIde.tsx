'use client';

import dynamic from 'next/dynamic';
import type { EditorProps } from '@monaco-editor/react';
import { useEffect, useMemo, useRef, useState, type ComponentType, type FormEvent } from 'react';
import { apiRequest, errorText } from '../../lib/client';
import { languageLabel } from '../../lib/labels';

/**
 * Trình soạn mã nguồn trực tiếp cho workspace của đội: nhiều tệp trong trình duyệt, đóng thành
 * gói ZIP *không nén* ngay trên máy khách rồi gửi lên đúng endpoint mà form “Tải .zip” dùng
 * (`POST /api/v2/tournaments/:id/submissions` với `{teamId, language, entrypoint, zipBase64}`).
 *
 * Không có bước “dựng thử” nào ở đây: sau khi nộp, receipt của server trả về ở trạng thái
 * VALIDATING và bảng lịch sử của `SubmissionPanel` mới là nơi hiện kết quả biên dịch thật.
 */

/**
 * Bản sao giới hạn nhận gói của server (`packages/server/src/submissions/artifact-store.ts`):
 * MAX_ZIP_BYTES = 2 MiB, MAX_FILE_BYTES = 256 KiB, MAX_EXPANDED_BYTES = 4 MiB,
 * MAX_REGULAR_FILES = 128. Trình soạn thảo siết số tệp xuống 64 để danh sách còn dùng được;
 * ngưỡng chặt hơn server thì không bao giờ bị server từ chối ngược lại.
 */
const MAX_ZIP_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_EDITOR_FILES = 64;
const SERVER_MAX_REGULAR_FILES = 128;
const ZIP_LIMIT_LABEL = `${MAX_ZIP_BYTES / (1024 * 1024)} MiB`;

/** `FORBIDDEN_EXTENSIONS` của artifact-store.ts: server từ chối mọi tệp nhị phân/thực thi. */
const FORBIDDEN_EXTENSIONS: Record<string, true> = {
  '.exe': true,
  '.so': true,
  '.dll': true,
  '.dylib': true,
  '.bin': true,
  '.pyc': true,
  '.pyo': true,
  '.pyd': true,
  '.o': true,
  '.a': true,
  '.obj': true,
  '.class': true,
  '.jar': true,
  '.wasm': true,
};

const LANGUAGES = ['PYTHON', 'TYPESCRIPT', 'CPP'] as const;

/** Đuôi tệp được phép làm entrypoint (`parseAndValidateZip` kiểm tra đúng bộ này theo ngôn ngữ). */
const ENTRYPOINT_EXTENSIONS: Record<string, string> = {
  '.py': 'PYTHON',
  '.ts': 'TYPESCRIPT',
  '.js': 'TYPESCRIPT',
  '.cpp': 'CPP',
};

const TEXT_ENCODER = new TextEncoder();

/**
 * `ssr: false` là bắt buộc: Monaco chỉ tồn tại trong trình duyệt (nó dựng worker + DOM riêng),
 * nên module được nạp động sau khi hydrate. `loading` giữ chỗ trong lúc chờ.
 */
const MonacoEditor = dynamic<EditorProps>(
  () =>
    import('@monaco-editor/react').then((module) => {
      // Configure the shared loader before React mounts Editor (its mount effect
      // calls loader.init). The complete matching distribution is copied by the
      // web predev/prebuild hook; workers, CSS and fonts remain same-origin too.
      // Do not use the loader's jsDelivr default, even when the LAN has Internet.
      module.loader.config({ paths: { vs: '/monaco/vs' } });
      // Tuỳ cách bundler gói lại, component có thể nằm ở `default` hoặc lồng thêm một lớp `default`.
      const first = (module as { default?: unknown } | null)?.default ?? module;
      const second = (first as { default?: unknown } | null)?.default ?? first;
      return second as ComponentType<EditorProps>;
    }),
  {
    ssr: false,
    loading: () => <p className="p-3 text-xs text-[var(--text-secondary)]">Đang tải trình soạn thảo…</p>,
  }
);

import {
  BOT_TEMPLATES as TEMPLATES,
  CPP_BOT_TEMPLATE as CPP_TEMPLATE,
  PYTHON_BOT_TEMPLATE as PYTHON_TEMPLATE,
  TYPESCRIPT_BOT_TEMPLATE as TYPESCRIPT_TEMPLATE,
} from '@oantuti/protocol/bot-templates';

const DEFAULT_FILE_NAME: Record<string, string> = {
  PYTHON: 'main.py',
  TYPESCRIPT: 'index.ts',
  CPP: 'main.cpp',
};

interface SourceFile {
  readonly id: string;
  readonly name: string;
  /** Nội dung hiện tại; `bytes` luôn được dựng cùng lúc nên hai trường không bao giờ lệch nhau. */
  readonly content: string;
  readonly bytes: Uint8Array;
}

interface StatusMessage {
  readonly tone: 'error' | 'info';
  readonly text: string;
}

function makeFile(id: string, name: string, content: string): SourceFile {
  return { id, name, content, bytes: TEXT_ENCODER.encode(content) };
}

function withContent(file: SourceFile, content: string): SourceFile {
  return { ...file, content, bytes: TEXT_ENCODER.encode(content) };
}

/** Đường dẫn đã chuẩn hoá theo cách server chuẩn hoá tên trong zip (`\` -> `/`). */
function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, '/');
}

/** Ngôn ngữ của một tệp theo đuôi, hoặc null khi đuôi không phải nguồn bot. */
function languageForPath(path: string): string | null {
  const lower = normalizePath(path).toLowerCase();
  for (const [extension, language] of Object.entries(ENTRYPOINT_EXTENSIONS)) {
    if (lower.endsWith(extension)) return language;
  }
  return null;
}

function extensionOf(path: string): string {
  const normalized = normalizePath(path).toLowerCase();
  const index = normalized.lastIndexOf('.');
  return index <= 0 ? '' : normalized.slice(index);
}

/** Ngôn ngữ tô màu của Monaco theo đuôi tệp. */
function monacoLanguageForPath(path: string): string {
  const extension = extensionOf(path);
  if (extension === '.py') return 'python';
  if (extension === '.ts') return 'typescript';
  if (extension === '.js') return 'javascript';
  if (extension === '.cpp' || extension === '.hpp' || extension === '.h') return 'cpp';
  if (extension === '.json') return 'json';
  if (extension === '.md') return 'markdown';
  return 'plaintext';
}

/**
 * Cùng quy tắc đường dẫn mà `parseAndValidateZip` áp dụng: không đường dẫn tuyệt đối, không
 * đoạn `..`. Ở đây chặt hơn (mọi đoạn `..`) để trình soạn thảo không bao giờ dựng ra gói mà
 * server chắc chắn từ chối.
 */
function invalidPathReason(path: string): string | null {
  const normalized = normalizePath(path);
  if (normalized === '') return 'Tên tệp không được để trống.';
  if (normalized.startsWith('/') || normalized.startsWith('//') || /^[A-Za-z]:/.test(normalized)) {
    return `Đường dẫn tuyệt đối không được phép: ${path.trim()}`;
  }
  if (normalized.split('/').includes('..')) {
    return `Đường dẫn chứa ".." không được phép: ${path.trim()}`;
  }
  if (normalized.endsWith('/')) return `Tên tệp không được kết thúc bằng "/": ${path.trim()}`;
  if (normalized.length > 255) return 'Tên tệp quá dài (tối đa 255 ký tự).';
  return null;
}

function tooManyFilesReason(count: number): string {
  return `Trình soạn thảo chỉ cho tối đa ${MAX_EDITOR_FILES} tệp (server cho phép ${SERVER_MAX_REGULAR_FILES} tệp); hiện có ${count} tệp.`;
}

/**
 * Lý do chặn nộp bài, hoặc null khi gói hợp lệ. Dùng cho cả cảnh báo trực tiếp lẫn chốt chặn
 * lúc bấm nộp, nên thông báo không bao giờ lệch nhau. Kích thước tính bằng byte UTF-8 thật
 * (`file.bytes`), đúng như server đếm sau khi giải nén.
 */
function findBlockingReason(
  files: readonly SourceFile[],
  entrypoint: string,
  language: string
): string | null {
  if (files.length === 0) return 'Chưa có tệp nào trong gói — hãy thêm ít nhất một tệp.';
  if (files.length > MAX_EDITOR_FILES) return tooManyFilesReason(files.length);

  const seen = new Map<string, string>();
  let totalBytes = 0;
  for (const file of files) {
    const reason = invalidPathReason(file.name);
    if (reason !== null) return reason;
    const normalized = normalizePath(file.name);
    const lower = normalized.toLowerCase();
    const previous = seen.get(lower);
    if (previous !== undefined) {
      return `Trùng tên tệp (không phân biệt hoa/thường): ${normalized} và ${previous}.`;
    }
    seen.set(lower, normalized);
    if (FORBIDDEN_EXTENSIONS[extensionOf(normalized)] === true) {
      return `Không được đóng gói tệp nhị phân/thực thi: ${normalized}`;
    }
    const size = file.bytes.length;
    if (size > MAX_FILE_BYTES) {
      return `Tệp ${normalized} vượt giới hạn ${MAX_FILE_BYTES / 1024} KiB của server (${size} byte).`;
    }
    totalBytes += size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      return `Tổng mã nguồn vượt giới hạn ${MAX_TOTAL_BYTES / (1024 * 1024)} MiB của server (${totalBytes} byte).`;
    }
  }

  if (entrypoint === '') return 'Chưa có tệp entrypoint (.py, .ts, .js hoặc .cpp) nào trong gói.';
  const derived = languageForPath(entrypoint);
  if (derived === null) {
    return `Entrypoint ${entrypoint} phải có đuôi .py, .ts, .js hoặc .cpp.`;
  }
  if (derived !== language) {
    return `Entrypoint ${entrypoint} là ${languageLabel[derived] ?? derived}, không khớp ngôn ngữ đang chọn (${
      languageLabel[language] ?? language
    }). Hãy đổi ngôn ngữ hoặc chọn entrypoint khác.`;
  }
  return null;
}

/* ---------------------------------------------------------------------------------------------
 * ZIP writer
 *
 * Gói được ghi bằng phương thức *stored* (0): không nén nên không cần thuật toán deflate, và
 * `parseAndValidateZip` đọc nhánh `method === 0` bằng `subarray` nên byte nội dung phải khớp
 * tuyệt đối với `compressedSize`/`uncompressedSize` ghi trong header.
 *
 * Bố cục: [local header 30B + tên UTF-8 + dữ liệu] cho từng tệp, rồi tới central directory
 * (central header 46B + tên) cho từng tệp, cuối cùng là EOCD 22B không comment nên server tìm
 * thấy chữ ký 0x06054b50 ngay tại `length - 22`.
 * ------------------------------------------------------------------------------------------- */

/** Bảng CRC-32 (đa thức 0xEDB88320) dựng một lần; CRC của mỗi tệp ghi ở cả hai header. */
const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    value = CRC32_TABLE[(value ^ bytes[index]) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

/** Dấu thời gian MS-DOS: giây chia 2, năm tính từ 1980 — dùng chung cho mọi tệp trong gói. */
function dosTimestamp(now: Date): { time: number; date: number } {
  const time =
    ((now.getHours() & 0x1f) << 11) | ((now.getMinutes() & 0x3f) << 5) | (Math.floor(now.getSeconds() / 2) & 0x1f);
  const date =
    (((now.getFullYear() - 1980) & 0x7f) << 9) | (((now.getMonth() + 1) & 0x0f) << 5) | (now.getDate() & 0x1f);
  return { time, date };
}

interface ZipEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
}

interface PreparedEntry {
  readonly nameBytes: Uint8Array;
  readonly bytes: Uint8Array;
  readonly crc: number;
  readonly offset: number;
}

/** Dựng ZIP stored trong bộ nhớ; tên tệp ghi bằng UTF-8 (bit 11 của general-purpose flags). */
function writeStoredZip(entries: readonly ZipEntry[]): Uint8Array {
  const stamp = dosTimestamp(new Date());
  const prepared: PreparedEntry[] = [];
  let localBytes = 0;
  for (const entry of entries) {
    const nameBytes = TEXT_ENCODER.encode(entry.name);
    prepared.push({ nameBytes, bytes: entry.bytes, crc: crc32(entry.bytes), offset: localBytes });
    localBytes += 30 + nameBytes.length + entry.bytes.length;
  }
  let centralBytes = 0;
  for (const entry of prepared) centralBytes += 46 + entry.nameBytes.length;

  const archive = new Uint8Array(localBytes + centralBytes + 22);
  const view = new DataView(archive.buffer);

  for (const entry of prepared) {
    const size = entry.bytes.length;
    let at = entry.offset;
    view.setUint32(at, 0x04034b50, true); // chữ ký local file header
    view.setUint16(at + 4, 20, true); // phiên bản tối thiểu để giải nén
    view.setUint16(at + 6, 0x0800, true); // bit 11: tên là UTF-8
    view.setUint16(at + 8, 0, true); // phương thức 0 = stored
    view.setUint16(at + 10, stamp.time, true);
    view.setUint16(at + 12, stamp.date, true);
    view.setUint32(at + 14, entry.crc, true);
    view.setUint32(at + 18, size, true); // compressed size = uncompressed size
    view.setUint32(at + 22, size, true);
    view.setUint16(at + 26, entry.nameBytes.length, true);
    view.setUint16(at + 28, 0, true); // không có extra field
    at += 30;
    archive.set(entry.nameBytes, at);
    at += entry.nameBytes.length;
    archive.set(entry.bytes, at);
  }

  const centralStart = localBytes;
  let at = centralStart;
  for (const entry of prepared) {
    const size = entry.bytes.length;
    view.setUint32(at, 0x02014b50, true); // chữ ký central directory header
    view.setUint16(at + 4, 0x0314, true); // tạo bởi UNIX, phiên bản 2.0
    view.setUint16(at + 6, 20, true);
    view.setUint16(at + 8, 0x0800, true);
    view.setUint16(at + 10, 0, true);
    view.setUint16(at + 12, stamp.time, true);
    view.setUint16(at + 14, stamp.date, true);
    view.setUint32(at + 16, entry.crc, true);
    view.setUint32(at + 20, size, true);
    view.setUint32(at + 24, size, true);
    view.setUint16(at + 28, entry.nameBytes.length, true);
    view.setUint16(at + 30, 0, true); // extra
    view.setUint16(at + 32, 0, true); // comment
    view.setUint16(at + 34, 0, true); // đĩa bắt đầu
    view.setUint16(at + 36, 0, true); // thuộc tính nội bộ
    view.setUint32(at + 38, (0o100644 << 16) >>> 0, true); // mode Unix 0644 -> không phải symlink
    view.setUint32(at + 42, entry.offset, true);
    at += 46;
    archive.set(entry.nameBytes, at);
    at += entry.nameBytes.length;
  }

  view.setUint32(at, 0x06054b50, true); // chữ ký EOCD
  view.setUint16(at + 4, 0, true); // số đĩa
  view.setUint16(at + 6, 0, true); // đĩa chứa central directory
  view.setUint16(at + 8, prepared.length, true); // số bản ghi trên đĩa này
  view.setUint16(at + 10, prepared.length, true); // tổng số bản ghi
  view.setUint32(at + 12, at - centralStart, true); // kích thước central directory
  view.setUint32(at + 16, centralStart, true); // offset central directory
  view.setUint16(at + 20, 0, true); // comment rỗng
  return archive;
}

/** Chia khối: `String.fromCharCode(...bytes)` tràn ngăn xếp với gói vài MiB. */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + CHUNK)));
  }
  return btoa(parts.join(''));
}

export default function SourceIde({
  tournamentId,
  teamId,
  onSubmitted,
}: {
  tournamentId: string;
  teamId: string;
  /** Nhận nguyên payload của receipt để `SubmissionPanel` chuẩn hoá và hiện bằng khối có sẵn. */
  onSubmitted: (payload: unknown) => void;
}) {
  const [files, setFiles] = useState<SourceFile[]>(() => [
    makeFile('f1', DEFAULT_FILE_NAME.PYTHON ?? 'main.py', PYTHON_TEMPLATE),
  ]);
  const [selectedId, setSelectedId] = useState('f1');
  const [entrypointChoice, setEntrypointChoice] = useState(DEFAULT_FILE_NAME.PYTHON ?? 'main.py');
  const [language, setLanguage] = useState<string>(LANGUAGES[0]);
  const [newFileName, setNewFileName] = useState('');
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [sending, setSending] = useState(false);
  const nextFileId = useRef(2);
  const lastEntrypoint = useRef(entrypointChoice);
  const draftKey = `oantuti:source-draft:${tournamentId}:${teamId}`;
  const [draftLoaded, setDraftLoaded] = useState(false);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(draftKey);
      if (raw) {
        const draft = JSON.parse(raw) as { files?: unknown; selectedId?: unknown; entrypoint?: unknown; language?: unknown };
        if (Array.isArray(draft.files) && draft.files.length > 0 && draft.files.length <= MAX_EDITOR_FILES) {
          const restored: SourceFile[] = [];
          for (const value of draft.files) {
            if (!value || typeof value !== 'object') throw new Error('Invalid draft');
            const file = value as Record<string, unknown>;
            if (typeof file.id !== 'string' || typeof file.name !== 'string' || typeof file.content !== 'string') throw new Error('Invalid draft file');
            restored.push(makeFile(file.id, file.name, file.content));
          }
          setFiles(restored);
          setSelectedId(typeof draft.selectedId === 'string' ? draft.selectedId : restored[0]!.id);
          if (typeof draft.entrypoint === 'string') setEntrypointChoice(draft.entrypoint);
          if (typeof draft.language === 'string' && LANGUAGES.some((item) => item === draft.language)) setLanguage(draft.language);
          nextFileId.current = restored.reduce((max, file) => Math.max(max, Number(file.id.replace(/^f/, '')) || 0), 1) + 1;
        }
      }
    } catch {
      setStatus({ tone: 'error', text: 'Không đọc được bản nháp đã lưu trên trình duyệt.' });
    }
    setDraftLoaded(true);
  }, [draftKey]);

  useEffect(() => {
    if (!draftLoaded) return;
    try {
      sessionStorage.setItem(draftKey, JSON.stringify({
        files: files.map(({ id, name, content }) => ({ id, name, content })),
        selectedId,
        entrypoint: entrypointChoice,
        language,
      }));
    } catch {
      setStatus({ tone: 'error', text: 'Không lưu được bản nháp. Hãy giữ trang này mở hoặc tải mã nguồn trước khi rời trang.' });
    }
  }, [draftLoaded, draftKey, files, selectedId, entrypointChoice, language]);

  const selected = files.find((file) => file.id === selectedId) ?? files[0] ?? null;
  const entrypointOptions = files.filter((file) => languageForPath(file.name) !== null);
  const entrypoint = entrypointOptions.some((file) => file.name === entrypointChoice)
    ? entrypointChoice
    : entrypointOptions[0]?.name ?? '';

  /** Entrypoint quyết định ngôn ngữ: đổi entrypoint (hoặc đổi tên tệp entrypoint) là đổi theo. */
  useEffect(() => {
    if (lastEntrypoint.current === entrypoint) return;
    lastEntrypoint.current = entrypoint;
    const derived = languageForPath(entrypoint);
    if (derived !== null) setLanguage(derived);
  }, [entrypoint]);

  const blockingReason = useMemo(
    () => findBlockingReason(files, entrypoint, language),
    [files, entrypoint, language]
  );
  const totalBytes = files.reduce((total, file) => total + file.bytes.length, 0);

  function updateFile(id: string, patch: { name?: string; content?: string }) {
    setFiles((current) =>
      current.map((file) => {
        if (file.id !== id) return file;
        const next = { ...file, name: patch.name ?? file.name };
        return patch.content === undefined ? next : withContent(next, patch.content);
      })
    );
  }

  function onAddFile() {
    const name = newFileName.trim();
    if (files.length >= MAX_EDITOR_FILES) {
      setStatus({ tone: 'error', text: tooManyFilesReason(files.length) });
      return;
    }
    const reason = invalidPathReason(name);
    if (reason !== null) {
      setStatus({ tone: 'error', text: reason });
      return;
    }
    const normalized = normalizePath(name);
    if (files.some((file) => normalizePath(file.name).toLowerCase() === normalized.toLowerCase())) {
      setStatus({ tone: 'error', text: `Tệp ${normalized} đã có trong gói.` });
      return;
    }
    if (FORBIDDEN_EXTENSIONS[extensionOf(normalized)] === true) {
      setStatus({ tone: 'error', text: `Không được thêm tệp nhị phân/thực thi: ${normalized}` });
      return;
    }
    const derived = languageForPath(normalized);
    const id = `f${nextFileId.current}`;
    nextFileId.current += 1;
    setFiles((current) => [...current, makeFile(id, normalized, TEMPLATES[derived ?? language])]);
    setSelectedId(id);
    setNewFileName('');
    setStatus({
      tone: 'info',
      text: derived === null ? `Đã thêm ${normalized} (tệp trống).` : `Đã thêm ${normalized} kèm khung mã ${languageLabel[derived] ?? derived}.`,
    });
  }

  function onDeleteFile(id: string) {
    const remaining = files.filter((file) => file.id !== id);
    setFiles(remaining);
    if (id === selectedId) setSelectedId(remaining[0]?.id ?? '');
    setStatus(null);
  }

  function onInsertTemplate() {
    if (selected === null) {
      setStatus({ tone: 'error', text: 'Hãy chọn hoặc thêm một tệp trước.' });
      return;
    }
    const derived = languageForPath(selected.name);
    if (derived === null) {
      setStatus({
        tone: 'error',
        text: `Chèn mẫu cần tên tệp có đuôi .py, .ts, .js hoặc .cpp (đang là ${selected.name || '(chưa đặt tên)'}).`,
      });
      return;
    }
    updateFile(selected.id, { content: TEMPLATES[derived] });
    setStatus({
      tone: 'info',
      text: `Đã thay nội dung ${normalizePath(selected.name)} bằng khung mã ${languageLabel[derived] ?? derived}.`,
    });
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending) return;
    // Tính lại lúc nộp: đây là chốt chặn cuối, không phụ thuộc trạng thái cảnh báo trên giao diện.
    const reason = findBlockingReason(files, entrypoint, language);
    if (reason !== null) {
      setStatus({ tone: 'error', text: reason });
      return;
    }
    setSending(true);
    setStatus(null);
    try {
      const archive = writeStoredZip(
        files.map((file) => ({ name: normalizePath(file.name), bytes: file.bytes }))
      );
      if (archive.length > MAX_ZIP_BYTES) {
        setStatus({
          tone: 'error',
          text: `Gói ZIP không nén vượt giới hạn ${ZIP_LIMIT_LABEL} của server (${archive.length} byte). Hãy bớt tệp hoặc rút gọn mã nguồn.`,
        });
        return;
      }
      const result = await apiRequest<unknown>(`/api/v2/tournaments/${tournamentId}/submissions`, {
        method: 'POST',
        body: {
          teamId,
          language,
          entrypoint,
          zipBase64: toBase64(archive),
        },
      });
      if (!result.ok) {
        setStatus({ tone: 'error', text: errorText(result, 'Nộp mã nguồn thất bại.') });
        return;
      }
      setStatus({ tone: 'info', text: 'Server đã nhận bài — receipt và kết quả dựng thật ở khối bên dưới.' });
      onSubmitted(result.data);
    } catch {
      setStatus({ tone: 'error', text: 'Không dựng được gói ZIP trong trình duyệt.' });
    } finally {
      setSending(false);
    }
  }

  const selectClass =
    'h-10 w-full rounded-md border border-[var(--border-control)] bg-[var(--canvas)] px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-secondary)]';

  return (
    <form onSubmit={onSubmit} className="mt-3 flex flex-col gap-3">
      <p className="text-xs text-[var(--text-secondary)]">
        Soạn trực tiếp: mọi tệp dưới đây được đóng thành một gói ZIP không nén ngay trong trình duyệt rồi gửi lên
        cùng endpoint với đường “Tải .zip”.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
          <span className="font-medium text-[var(--text-primary)]">Ngôn ngữ</span>
          <select value={language} onChange={(event) => setLanguage(event.target.value)} className={selectClass}>
            {LANGUAGES.map((value) => (
              <option key={value} value={value}>
                {languageLabel[value] ?? value}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
          <span className="font-medium text-[var(--text-primary)]">Entrypoint (đường dẫn trong gói)</span>
          <select
            value={entrypoint}
            onChange={(event) => setEntrypointChoice(event.target.value)}
            disabled={entrypointOptions.length === 0}
            className={`${selectClass} disabled:opacity-60`}
          >
            {entrypointOptions.length === 0 ? (
              <option value="">— chưa có tệp .py / .ts / .js / .cpp —</option>
            ) : (
              entrypointOptions.map((file) => (
                <option key={file.id} value={file.name}>
                  {file.name}
                </option>
              ))
            )}
          </select>
        </label>
      </div>

      <p className="text-xs text-[var(--text-secondary)]">
        Entrypoint quyết định ngôn ngữ biên dịch:{' '}
        <span className="font-mono">{entrypoint || '—'}</span> ·{' '}
        {languageLabel[language] ?? language}
      </p>

      <div className="flex min-w-0 flex-col gap-3 rounded-md border border-[var(--border-subtle)] bg-[var(--canvas)] p-3">
        <div className="flex flex-wrap gap-1 border-b border-[var(--border-subtle)] pb-2">
          {files.length === 0 ? (
            <span className="px-1 py-1 text-xs text-[var(--text-secondary)]">Chưa có tệp nào trong gói.</span>
          ) : (
            files.map((file) => {
              const isSelected = selected !== null && file.id === selected.id;
              return (
                <span
                  key={file.id}
                  className={`flex max-w-full items-center gap-1 rounded border bg-[var(--canvas)] pl-2 ${
                    isSelected ? 'border-[var(--accent-secondary)]' : 'border-[var(--border-subtle)]'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedId(file.id)}
                    aria-pressed={isSelected}
                    title={file.name}
                    className={`max-w-[10rem] truncate py-1 text-left font-mono text-xs sm:max-w-[16rem] ${
                      isSelected ? 'text-[var(--accent-secondary)]' : 'text-[var(--text-secondary)]'
                    }`}
                  >
                    {file.name === '' ? '(chưa đặt tên)' : file.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeleteFile(file.id)}
                    aria-label={`Xoá tệp ${file.name}`}
                    className="px-2 py-1 text-xs text-[var(--danger-text)]"
                  >
                    Xoá
                  </button>
                </span>
              );
            })
          )}
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-0 basis-48 flex-1 flex-col gap-1 text-xs text-[var(--text-secondary)]">
            <span className="font-medium text-[var(--text-primary)]">Tên tệp đang mở (đổi tên tại đây)</span>
            <input
              value={selected?.name ?? ''}
              onChange={(event) => {
                if (selected !== null) updateFile(selected.id, { name: event.target.value });
              }}
              disabled={selected === null}
              spellCheck={false}
              placeholder="main.py"
              className="h-10 w-full rounded-md border border-[var(--border-control)] bg-[var(--canvas)] px-3 font-mono text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-secondary)] disabled:opacity-60"
            />
          </label>
          <button
            type="button"
            onClick={onInsertTemplate}
            disabled={selected === null}
            className="h-10 rounded-md border border-[var(--border-control)] px-3 text-xs text-[var(--text-primary)] disabled:opacity-60"
          >
            Chèn mẫu
          </button>
        </div>

        {/* Chiều cao cố định + overflow-hidden: Monaco tự cuộn ngang bên trong nên ở 390px trang không bị tràn. */}
        <div className="h-[320px] min-h-[240px] w-full overflow-hidden rounded-md border border-[var(--border-control)] sm:h-[440px]">
          {selected !== null ? (
            <MonacoEditor
              height="100%"
              width="100%"
              path={selected.id}
              language={monacoLanguageForPath(selected.name)}
              theme="oantuti-charcoal"
              beforeMount={(monaco: Parameters<NonNullable<EditorProps['beforeMount']>>[0]) => {
                monaco.editor.defineTheme('oantuti-charcoal', {
                  base: 'vs-dark',
                  inherit: true,
                  rules: [],
                  colors: {
                    'editor.background': '#0f1923',
                    'editor.foreground': '#ece8e1',
                    'editorLineNumber.foreground': '#6c7780',
                    'editor.lineHighlightBackground': '#17202a',
                    'editor.selectionBackground': '#2a3744',
                    'editorWidget.background': '#17202a',
                    'editorCursor.foreground': '#ff4655',
                  },
                });
              }}
              value={selected.content}
              onChange={(value: string | undefined) => updateFile(selected.id, { content: value ?? '' })}
              options={{
                minimap: { enabled: false },
                fontSize: 12,
                tabSize: 4,
                scrollBeyondLastLine: false,
                automaticLayout: true,
                wordWrap: 'off',
              }}
            />
          ) : (
            <p className="p-3 text-xs text-[var(--text-secondary)]">
              Hãy thêm một tệp để bắt đầu soạn mã.
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-0 basis-48 flex-1 flex-col gap-1 text-xs text-[var(--text-secondary)]">
            <span className="font-medium text-[var(--text-primary)]">Thêm tệp mới</span>
            <input
              value={newFileName}
              onChange={(event) => setNewFileName(event.target.value)}
              spellCheck={false}
              placeholder="helpers.py"
              className="h-10 w-full rounded-md border border-[var(--border-control)] bg-[var(--canvas)] px-3 font-mono text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-secondary)]"
            />
          </label>
          <button
            type="button"
            onClick={onAddFile}
            className="h-10 rounded-md border border-[var(--border-control)] px-3 text-xs text-[var(--text-primary)]"
          >
            Thêm tệp
          </button>
        </div>

        <p className="text-xs text-[var(--text-secondary)]">
          {files.length} tệp · {totalBytes} byte mã nguồn (giới hạn server: {MAX_FILE_BYTES / 1024} KiB/tệp,{' '}
          {MAX_TOTAL_BYTES / (1024 * 1024)} MiB tổng, {ZIP_LIMIT_LABEL} cho gói ZIP).
        </p>
      </div>

      {blockingReason !== null ? (
        <p className="rounded-md border border-[var(--warning-text)] px-3 py-2 text-xs text-[var(--warning-text)]">
          {blockingReason}
        </p>
      ) : null}
      {status !== null ? (
        <p
          className={
            status.tone === 'error'
              ? 'rounded-md border border-[var(--danger-text)] px-3 py-2 text-sm text-[var(--danger-text)]'
              : 'rounded-md border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-3 py-2 text-xs text-[var(--text-secondary)]'
          }
        >
          {status.text}
        </p>
      ) : null}

      <div>
        <button
          type="submit"
          disabled={sending || blockingReason !== null}
          className="vct-btn-primary !py-2.5 !px-5 !text-xs !rounded-xl disabled:opacity-60 cursor-pointer"
        >
          {sending ? 'Đang nộp bài...' : 'Nộp bài từ trình soạn thảo'}
        </button>
      </div>
    </form>
  );
}
