'use client';

import { useState } from 'react';

import type { ReplayPayload } from '../../lib/replay';
import { verifyReplayWithWasm, type WasmVerifierVerdict } from '../../lib/wasm-verifier';

type PanelState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running' }
  | { readonly kind: 'done'; readonly verdict: WasmVerifierVerdict | null }
  | { readonly kind: 'error'; readonly message: string };

const sideLabel: Record<string, string> = { WHITE: 'Trắng', BLACK: 'Đen' };

/**
 * Independent, client-side replay check: the same Rust rules compiled to WASM replay the trace in
 * this browser tab, so the page does not have to be trusted to know the published result is real.
 */
export default function WasmVerifierPanel({ payload }: { readonly payload: ReplayPayload }) {
  const [state, setState] = useState<PanelState>({ kind: 'idle' });

  async function run() {
    setState({ kind: 'running' });
    try {
      const verdict = await verifyReplayWithWasm(payload);
      setState({ kind: 'done', verdict });
    } catch (error) {
      setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  return (
    <section className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
            Xác minh độc lập (WASM)
          </p>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            Chạy lại trace bằng chính engine Rust (bản WASM) ngay trong trình duyệt này — không cần tin vào phản hồi
            của server.
          </p>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={state.kind === 'running'}
          className="rounded-sm border border-[var(--action)] bg-[var(--action)] px-4 py-2 text-sm font-semibold text-[#151618] hover:bg-[var(--action-hover)] disabled:opacity-60"
        >
          {state.kind === 'running' ? 'Đang xác minh…' : 'Xác minh bằng engine WASM'}
        </button>
      </div>

      {state.kind === 'error' ? (
        <p className="mt-4 break-words rounded-sm border border-[var(--border-subtle)] bg-[var(--danger-tint)] px-3 py-2 text-sm text-[var(--danger-text)]">
          <span className="font-semibold">Không chạy được bộ xác minh.</span> {state.message}
        </p>
      ) : null}

      {state.kind === 'done' && state.verdict === null ? (
        <p className="mt-4 rounded-sm border border-[var(--border-subtle)] bg-[var(--warning-tint)] px-3 py-2 text-sm text-[var(--warning-text)]">
          Replay cũ không kèm bàn đấu nên engine WASM không thể dựng lại thế cờ; không có kết luận xác minh.
        </p>
      ) : null}

      {state.kind === 'done' && state.verdict !== null ? (
        state.verdict.ok ? (
          <p className="mt-4 rounded-sm border border-[var(--border-subtle)] bg-[var(--success-tint)] px-3 py-2 text-sm text-[var(--success-text)]">
            <span className="font-semibold">Engine WASM chấp nhận trace.</span> {state.verdict.appliedPly} nước được áp dụng
            · kết cục {sideLabel[state.verdict.winner ?? ''] ?? 'Hòa/không thắng'} ·{' '}
            <span className="font-mono">{state.verdict.reason ?? '—'}</span>
          </p>
        ) : (
          <p className="mt-4 break-words rounded-sm border border-[var(--border-subtle)] bg-[var(--danger-tint)] px-3 py-2 text-sm text-[var(--danger-text)]">
            <span className="font-semibold">Engine WASM từ chối trace.</span>{' '}
            <span className="font-mono">{state.verdict.error ?? 'không rõ lý do'}</span>
          </p>
        )
      ) : null}
    </section>
  );
}
