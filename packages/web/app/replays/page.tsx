import type { Metadata } from 'next';
import Link from 'next/link';
import ReplayViewer from './ReplayViewer';

export const metadata: Metadata = { title: 'Xem lại ván đấu — OanTuTi Arena' };

/**
 * Replay entry point. Two ways in, one page:
 *
 *   /replays?game=<game id>   → đọc `/api/v2/games/:id/result` để lấy `replayDigest` rồi tải replay
 *   /replays?digest=<digest>  → tải thẳng `/api/v2/replays/:digest` (dùng cho replay bài kiểm thử riêng tư)
 *
 * Both values are read on the server, so the viewer only ever parses inside its own effects.
 */
export default async function ReplaysPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const rawGame = params.game;
  const rawDigest = params.digest;
  const gameId = (Array.isArray(rawGame) ? rawGame[0] : rawGame) ?? null;
  const digest = (Array.isArray(rawDigest) ? rawDigest[0] : rawDigest) ?? null;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <nav className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
        <Link className="hover:text-[var(--text-primary)]" href="/">
          Giải đấu
        </Link>
        <span>/</span>
        <span className="text-[var(--text-primary)]">Xem lại ván đấu</span>
      </nav>

      <section className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] px-4 py-4">
        <h1 className="text-xl font-semibold">Xem lại ván đấu</h1>
        <p className="mt-2 max-w-3xl text-sm text-[var(--text-secondary)]">
          Mở bằng <span className="font-mono">mã ván</span> (server sẽ tra digest của replay từ kết quả đã được chấp
          nhận) hoặc bằng <span className="font-mono">digest replay</span> khi bạn đã có digest — ví dụ replay của
          một bài kiểm thử riêng tư. Tệp replay được kiểm tra SHA-256 ngay trên trình duyệt trước khi hiển thị.
        </p>
        <form action="/replays" method="get" className="mt-4 flex flex-col gap-3 sm:flex-row">
          <input
            type="text"
            name="game"
            defaultValue={gameId ?? ''}
            placeholder="Mã ván (game id)"
            className="min-w-0 flex-1 rounded-md border border-[var(--border-control)] bg-[var(--surface-subtle)] px-3 py-2 text-sm text-[var(--text-primary)]"
          />
          <input
            type="text"
            name="digest"
            defaultValue={digest ?? ''}
            placeholder="hoặc digest replay (hex)"
            className="min-w-0 flex-1 rounded-md border border-[var(--border-control)] bg-[var(--surface-subtle)] px-3 py-2 text-sm text-[var(--text-primary)]"
          />
          <button
            type="submit"
            className="rounded-md bg-[var(--action)] px-5 py-2 text-sm font-semibold text-[#0B0D17]"
          >
            Xem replay
          </button>
        </form>
      </section>

      {gameId || digest ? (
        <ReplayViewer gameId={gameId} digest={digest} />
      ) : (
        <p className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] px-4 py-8 text-center text-sm text-[var(--text-secondary)]">
          Chưa có mã ván hoặc digest để mở. Hãy nhập một trong hai ô ở trên, hoặc bấm “Xem replay” từ nhánh đấu của
          giải (mã ván) hay từ bảng kiểm thử riêng tư (digest).
        </p>
      )}
    </div>
  );
}
