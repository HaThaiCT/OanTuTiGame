'use client';

import { useState } from 'react';
import SubmissionPanel from '../../workspace/SubmissionPanel';
import PrivateTestPanel from '../../workspace/PrivateTestPanel';

export default function TournamentSubmissionsTab({
  tournamentId,
  teamId,
  teamName,
  tournamentState,
  initialMode = 'submission',
}: {
  tournamentId: string;
  teamId: string;
  teamName?: string;
  tournamentState: string;
  initialMode?: 'submission' | 'test';
}) {
  const [mode, setMode] = useState<'submission' | 'test'>(initialMode);

  return (
    <div className="flex flex-col gap-6">
      {/* Sub-tab navigation */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface)] p-4 shadow-sm">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-[var(--text-secondary)] uppercase">
            Đang thao tác cho:
          </span>
          <span className="rounded-full border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-3 py-1 font-heading text-xs font-bold text-[var(--action)]">
            {teamName ?? teamId}
          </span>
        </div>

        <div className="flex items-center gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)] p-1">
          <button
            type="button"
            onClick={() => setMode('submission')}
            className={`rounded-lg px-4 py-2 font-heading text-xs font-bold transition-all cursor-pointer ${
              mode === 'submission'
                ? 'bg-[var(--surface)] text-[var(--action)] shadow-sm'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            Bài nộp thi đấu chính thức
          </button>
          <button
            type="button"
            onClick={() => setMode('test')}
            className={`rounded-lg px-4 py-2 font-heading text-xs font-bold transition-all cursor-pointer ${
              mode === 'test'
                ? 'bg-[var(--surface)] text-[var(--action)] shadow-sm'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            Chạy test riêng tư (IDE & Sandbox)
          </button>
        </div>
      </div>

      {/* Main Panel Display */}
      {mode === 'submission' ? (
        <div className="flex flex-col gap-4">
          <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)] p-4 text-xs text-[var(--text-secondary)] leading-relaxed">
            🚀 <strong className="text-[var(--text-primary)]">Lưu ý bài thi đấu:</strong> Bài nộp tại đây sẽ được hệ thống biên dịch, chạy smoke test và sử dụng trực tiếp trong các vòng đấu chính thức của giải. Bản nộp hợp lệ cuối cùng sẽ quyết định kết quả thi đấu của đội.
          </div>
          <SubmissionPanel
            key={`sub:${tournamentId}:${teamId}`}
            tournamentId={tournamentId}
            teamId={teamId}
            tournamentState={tournamentState}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)] p-4 text-xs text-[var(--text-secondary)] leading-relaxed">
            🧪 <strong className="text-[var(--text-primary)]">Môi trường test riêng tư:</strong> Bạn có thể tải file zip hoặc dùng trực tiếp Monaco IDE để viết code và chạy trận đấu thử nghiệm với bot mẫu. Kết quả test riêng tư hoàn toàn độc lập, không thay đổi điểm số hay ảnh hưởng tới các ván đấu chính thức.
          </div>
          <PrivateTestPanel
            key={`test:${tournamentId}:${teamId}`}
            tournamentId={tournamentId}
            teamId={teamId}
          />
        </div>
      )}
    </div>
  );
}
