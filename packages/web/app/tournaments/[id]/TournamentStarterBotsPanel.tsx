'use client';

import { useCallback, useEffect, useState } from 'react';
import { listStarterBots, starterBotDownloadUrl, type StarterBotTemplateDto } from '../../../lib/api';
import { languageLabel } from '../../../lib/labels';

export default function TournamentStarterBotsPanel() {
  const [bots, setBots] = useState<StarterBotTemplateDto[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadBots = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listStarterBots();
      if (!result.ok || !result.data) {
        setError(result.message ?? 'Không tải được danh sách bot mẫu.');
        setBots([]);
        return;
      }
      setBots(result.data.templates ?? []);
    } catch {
      setError('Lỗi kết nối khi tải danh sách bot mẫu.');
      setBots([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadBots();
  }, [loadBots]);

  return (
    <div className="flex flex-col gap-6">
      {/* Starter bots list section */}
      <section className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--border-subtle)] pb-4">
          <div>
            <h2 className="font-heading text-xl font-bold tracking-tight text-[var(--text-primary)]">
              Bot mẫu chính thức (Starter Bots)
            </h2>
            <p className="mt-1 text-xs text-[var(--text-secondary)]">
              Tải các gói mã nguồn mẫu chuẩn SDK do Ban tổ chức cung cấp để phát triển và kiểm thử bot thi đấu.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadBots()}
            disabled={loading}
            className="vct-btn-secondary !py-2 !px-4 !text-xs !rounded-full disabled:opacity-50"
          >
            {loading ? 'Đang tải…' : 'Làm mới'}
          </button>
        </div>

        {error ? (
          <div role="alert" className="mt-4 rounded-xl border border-[var(--danger-text)] bg-[var(--danger-tint)] p-4 text-xs text-[var(--danger-text)]">
            <p className="font-medium">{error}</p>
            <button
              type="button"
              onClick={() => void loadBots()}
              className="mt-2 text-[var(--action)] underline"
            >
              Thử lại
            </button>
          </div>
        ) : null}

        {loading && !bots ? (
          <div className="py-12 text-center font-mono text-xs text-[var(--text-secondary)]">
            // ĐANG TẢI DANH SÁCH BOT MẪU TỪ HỆ THỐNG...
          </div>
        ) : bots && bots.length === 0 ? (
          <div className="py-12 text-center">
            <p className="font-mono text-xs text-[var(--text-secondary)]">
              // CHƯA CÓ BOT MẪU NÀO ĐƯỢC BAN TỔ CHỨC CÔNG BỐ.
            </p>
            <p className="mt-2 text-xs text-[var(--text-secondary)]">
              Các bot mẫu Python, TypeScript và C++20 sẽ xuất hiện tại đây khi Ban tổ chức kích hoạt.
            </p>
          </div>
        ) : (
          <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {bots?.map((template) => (
              <div
                key={template.id}
                className="flex flex-col justify-between rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)] p-5 transition-colors hover:border-[var(--border-control)]"
              >
                <div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="rounded-full border border-[var(--border-subtle)] bg-[var(--surface)] px-2.5 py-0.5 font-mono text-[11px] font-bold uppercase tracking-wider text-[var(--action)]">
                      {languageLabel[template.language] ?? template.language}
                    </span>
                    <span className="font-mono text-[10px] text-[var(--text-secondary)]">
                      v{template.version}
                    </span>
                  </div>

                  <h3 className="mt-3 font-heading text-base font-bold text-[var(--text-primary)]">
                    {template.name}
                  </h3>

                  <p className="mt-1 font-mono text-xs text-[var(--text-secondary)]">
                    Entrypoint: <strong className="text-[var(--text-primary)]">{template.entrypoint}</strong>
                  </p>

                  {template.description ? (
                    <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)] line-clamp-3">
                      {template.description}
                    </p>
                  ) : null}
                </div>

                <div className="mt-5 border-t border-[var(--border-subtle)] pt-4">
                  <a
                    href={starterBotDownloadUrl(template.id)}
                    download
                    className="vct-btn-primary inline-flex w-full items-center justify-center gap-2 !py-2.5 !text-xs !rounded-xl"
                  >
                    <span>Tải gói zip</span>
                    <span className="font-mono text-[10px] opacity-75">(.zip)</span>
                    <span>↓</span>
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Local Testing Instructions */}
      <section className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-6 shadow-sm">
        <h2 className="font-heading text-xl font-bold tracking-tight text-[var(--text-primary)]">
          Hướng dẫn chạy kiểm thử trên máy cá nhân (Local)
        </h2>
        <p className="mt-1 text-xs text-[var(--text-secondary)]">
          Chạy giả lập trận đấu giữa hai bot trực tiếp bằng CLI để kiểm tra thuật toán trước khi nộp bài.
        </p>

        <div className="mt-6 flex flex-col gap-5 text-sm text-[var(--text-primary)]">
          <div className="flex flex-col gap-2">
            <h3 className="font-semibold text-xs font-mono uppercase tracking-wider text-[var(--action)]">
              1. Cấu trúc gói mã nguồn bot
            </h3>
            <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
              Gói zip bot tải về đã bao gồm cấu trúc hợp lệ để hệ thống Arena chạy được. Giữ nguyên tệp entrypoint (ví dụ: <code className="font-mono text-[var(--text-primary)]">main.py</code>, <code className="font-mono text-[var(--text-primary)]">index.ts</code>, <code className="font-mono text-[var(--text-primary)]">main.cpp</code>) tại thư mục gốc của gói nộp.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="font-semibold text-xs font-mono uppercase tracking-wider text-[var(--action)]">
              2. Lệnh thi đấu trực tiếp (CLI)
            </h3>
            <p className="text-xs text-[var(--text-secondary)]">
              Sử dụng lệnh CLI có sẵn trong repository OanTuTi để cho 2 bot đối đầu:
            </p>
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--canvas)] p-4 font-mono text-xs overflow-x-auto text-[var(--action)]">
              npm run match:play -- --white &lt;bot_white_path&gt; --black &lt;bot_black_path&gt; [--map &lt;map_path&gt;]
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="font-semibold text-xs font-mono uppercase tracking-wider text-[var(--action)]">
              3. Ví dụ chạy thực tế
            </h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)] p-3">
                <span className="font-mono text-[10px] font-bold text-[var(--accent-secondary)]">PYTHON VS PYTHON</span>
                <pre className="mt-1 font-mono text-xs text-[var(--text-primary)] overflow-x-auto whitespace-pre-wrap break-all">
npm run match:play -- --white bots/my_bot/main.py --black sdk/python/starter_bot.py
                </pre>
              </div>

              <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)] p-3">
                <span className="font-mono text-[10px] font-bold text-[var(--accent-secondary)]">TYPESCRIPT VS PYTHON</span>
                <pre className="mt-1 font-mono text-xs text-[var(--text-primary)] overflow-x-auto whitespace-pre-wrap break-all">
npm run match:play -- --white bots/my_ts/index.ts --black sdk/python/starter_bot.py
                </pre>
              </div>

              <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)] p-3">
                <span className="font-mono text-[10px] font-bold text-[var(--accent-secondary)]">C++20 VS STARTER</span>
                <pre className="mt-1 font-mono text-xs text-[var(--text-primary)] overflow-x-auto whitespace-pre-wrap break-all">
npm run match:play -- --white bots/my_cpp/main.cpp --black sdk/python/starter_bot.py
                </pre>
              </div>

              <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)] p-3">
                <span className="font-mono text-[10px] font-bold text-[var(--accent-secondary)]">CHỌN BẢN ĐỒ THI ĐẤU</span>
                <pre className="mt-1 font-mono text-xs text-[var(--text-primary)] overflow-x-auto whitespace-pre-wrap break-all">
npm run match:play -- --white botA.py --black botB.py --map maps/standard.json
                </pre>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-2 border-t border-[var(--border-subtle)] pt-4">
            <h3 className="font-semibold text-xs font-mono uppercase tracking-wider text-[var(--action)]">
              4. Yêu cầu môi trường local
            </h3>
            <ul className="list-disc pl-5 text-xs text-[var(--text-secondary)] space-y-1">
              <li>Cài đặt sẵn Node.js (phiên bản 20 trở lên) và npm.</li>
              <li>Với bot Python: Python 3.10+ sẵn trong PATH hệ thống.</li>
              <li>Với bot C++20: Trình biên dịch g++ hoặc clang++ hỗ trợ chuẩn C++20.</li>
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}
