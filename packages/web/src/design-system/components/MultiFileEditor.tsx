import React, { useState, useEffect } from 'react';
import { Button } from './Button.js';
import { Badge } from './Badge.js';
import { DraftPreserver, type DraftState } from '../DraftPreserver.js';

export interface MultiFileEditorProps {
  readonly teamId: string;
  readonly tournamentId: string;
  readonly initialLanguage?: 'PYTHON' | 'TYPESCRIPT' | 'CPP';
  readonly onRunPrivateTest?: (payload: { language: 'PYTHON' | 'TYPESCRIPT' | 'CPP'; entrypoint: string; files: Record<string, string> }) => Promise<void>;
  readonly onSubmitOfficial?: (payload: { language: 'PYTHON' | 'TYPESCRIPT' | 'CPP'; entrypoint: string; files: Record<string, string> }) => Promise<void>;
}

const defaultTemplates: Record<string, Record<string, string>> = {
  PYTHON: {
    'main.py': `# OanTuTi Python 3 Bot
import sys
import json

def on_init(init_data):
    return {"status": "READY"}

def on_turn(turn_data):
    return {"action": "PASS"}

if __name__ == "__main__":
    for line in sys.stdin:
        msg = json.loads(line)
        if msg.get("type") == "INIT":
            sys.stdout.write(json.dumps(on_init(msg)) + "\\n")
            sys.stdout.flush()
        elif msg.get("type") == "TURN":
            sys.stdout.write(json.dumps(on_turn(msg)) + "\\n")
            sys.stdout.flush()
`,
  },
  TYPESCRIPT: {
    'bot.ts': `// OanTuTi TypeScript Bot
import * as readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'INIT') {
    process.stdout.write(JSON.stringify({ status: 'READY' }) + '\\n');
  } else if (msg.type === 'TURN') {
    process.stdout.write(JSON.stringify({ action: 'PASS' }) + '\\n');
  }
});
`,
  },
  CPP: {
    'starter_bot.cpp': `// OanTuTi C++20 Bot
#include <iostream>
#include <string>

int main() {
    std::ios_base::sync_with_stdio(false);
    std::cin.tie(NULL);
    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.find("\"INIT\"") != std::string::npos) {
            std::cout << "{\"status\":\"READY\"}\\n" << std::flush;
        } else if (line.find("\"TURN\"") != std::string::npos) {
            std::cout << "{\"action\":\"PASS\"}\\n" << std::flush;
        }
    }
    return 0;
}
`,
  },
};

export const MultiFileEditor: React.FC<MultiFileEditorProps> = ({
  teamId,
  tournamentId,
  initialLanguage = 'PYTHON',
  onRunPrivateTest,
  onSubmitOfficial,
}) => {
  const [language, setLanguage] = useState<'PYTHON' | 'TYPESCRIPT' | 'CPP'>(initialLanguage);
  const [files, setFiles] = useState<Record<string, string>>(() => {
    const saved = DraftPreserver.loadDraft(teamId);
    if (saved) return saved.files;
    return defaultTemplates[initialLanguage];
  });

  const [activeFile, setActiveFile] = useState<string>(() => Object.keys(files)[0] ?? 'main.py');
  const [isSaved, setIsSaved] = useState<boolean>(true);
  const [isBusy, setIsBusy] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Auto-save draft on changes
  useEffect(() => {
    DraftPreserver.saveDraft({
      teamId,
      language,
      activeFile,
      files,
      lastModified: new Date().toISOString(),
    });
    setIsSaved(true);
  }, [files, activeFile, language, teamId]);

  const handleContentChange = (newContent: string) => {
    setFiles((prev) => ({
      ...prev,
      [activeFile]: newContent,
    }));
    setIsSaved(false);
  };

  const handleAddFile = () => {
    const name = window.prompt('Nhập tên file mới (ví dụ: strategy.py):');
    if (!name || files[name]) return;
    setFiles((prev) => ({ ...prev, [name]: '# New file\n' }));
    setActiveFile(name);
  };

  const handleDeleteFile = (fileName: string) => {
    if (Object.keys(files).length <= 1) {
      alert('Không thể xóa file duy nhất');
      return;
    }
    const nextFiles = { ...files };
    delete nextFiles[fileName];
    setFiles(nextFiles);
    setActiveFile(Object.keys(nextFiles)[0]);
  };

  const handleLanguageChange = (newLang: 'PYTHON' | 'TYPESCRIPT' | 'CPP') => {
    if (window.confirm('Đổi ngôn ngữ sẽ nạp file mẫu mới. Bản nháp hiện tại sẽ được lưu đè?')) {
      setLanguage(newLang);
      setFiles(defaultTemplates[newLang]);
      setActiveFile(Object.keys(defaultTemplates[newLang])[0]);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        backgroundColor: 'var(--surface)',
        border: '1px solid var(--border-subtle)',
        borderRadius: '8px',
        overflow: 'hidden',
      }}
    >
      {/* Top Toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 16px',
          backgroundColor: 'var(--surface-subtle)',
          borderBottom: '1px solid var(--border-subtle)',
          gap: '12px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <label style={{ fontSize: '13px', color: 'var(--text-secondary)', fontWeight: 600 }}>Ngôn ngữ:</label>
          <select
            value={language}
            onChange={(e) => handleLanguageChange(e.target.value as any)}
            style={{
              backgroundColor: 'var(--surface)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border-control)',
              borderRadius: '4px',
              padding: '4px 8px',
              fontSize: '13px',
              outline: 'none',
            }}
          >
            <option value="PYTHON">Python 3</option>
            <option value="TYPESCRIPT">TypeScript</option>
            <option value="CPP">C++20</option>
          </select>

          {isSaved ? (
            <Badge variant="neutral">Đã lưu nháp</Badge>
          ) : (
            <Badge variant="warning">Có thay đổi chưa lưu</Badge>
          )}
        </div>

        {/* Action Buttons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Button
            variant="secondary"
            size="sm"
            disabled={isBusy}
            onClick={async () => {
              setIsBusy(true);
              setStatusMessage('Đang chạy thử nghiệm riêng tư...');
              try {
                await onRunPrivateTest?.({ language, entrypoint: activeFile, files });
                setStatusMessage('Chạy thử nghiệm hoàn tất!');
              } catch (err: any) {
                setStatusMessage(`Lỗi chạy thử: ${err.message}`);
              } finally {
                setIsBusy(false);
              }
            }}
          >
            Chạy thử riêng tư
          </Button>

          <Button
            variant="primary"
            size="sm"
            disabled={isBusy}
            onClick={async () => {
              if (window.confirm('Xác nhận nộp bài chính thức cho giải đấu? Bản hợp lệ mới nhất sẽ tự động trở thành bài thi chính thức khi khóa giải.')) {
                setIsBusy(true);
                setStatusMessage('Đang gửi bài nộp chính thức...');
                try {
                  await onSubmitOfficial?.({ language, entrypoint: activeFile, files });
                  setStatusMessage('Nộp bài thành công!');
                } catch (err: any) {
                  setStatusMessage(`Lỗi nộp bài: ${err.message}`);
                } finally {
                  setIsBusy(false);
                }
              }
            }}
          >
            Nộp bài chính thức
          </Button>
        </div>
      </div>

      {/* Status Alert Banner */}
      {statusMessage && (
        <div
          style={{
            padding: '8px 16px',
            backgroundColor: 'rgba(103, 232, 249, 0.1)',
            color: 'var(--accent-secondary)',
            fontSize: '13px',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>{statusMessage}</span>
          <button
            onClick={() => setStatusMessage(null)}
            style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '14px' }}
          >
            ✕
          </button>
        </div>
      )}

      {/* File Tabs */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          backgroundColor: '#0d111c',
          borderBottom: '1px solid var(--border-subtle)',
          overflowX: 'auto',
          padding: '0 8px',
        }}
      >
        {Object.keys(files).map((fileName) => {
          const isActive = fileName === activeFile;
          return (
            <div
              key={fileName}
              onClick={() => setActiveFile(fileName)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 14px',
                fontSize: '13px',
                cursor: 'pointer',
                borderBottom: isActive ? '2px solid var(--action)' : '2px solid transparent',
                backgroundColor: isActive ? 'var(--surface)' : 'transparent',
                color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontWeight: isActive ? 600 : 400,
              }}
            >
              <span>{fileName}</span>
              {Object.keys(files).length > 1 && (
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteFile(fileName);
                  }}
                  style={{ opacity: 0.6, fontSize: '12px' }}
                  title="Xóa file"
                >
                  ✕
                </span>
              )}
            </div>
          );
        })}

        <button
          onClick={handleAddFile}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            padding: '8px 12px',
            fontSize: '14px',
          }}
          title="Thêm file mới"
        >
          + Thêm file
        </button>
      </div>

      {/* Editor Textarea with Monospace styling */}
      <div style={{ flex: 1, position: 'relative' }}>
        <textarea
          value={files[activeFile] ?? ''}
          onChange={(e) => handleContentChange(e.target.value)}
          spellCheck={false}
          style={{
            width: '100%',
            height: '100%',
            backgroundColor: '#0b0f19',
            color: 'var(--text-primary)',
            fontFamily: 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace',
            fontSize: '14px',
            lineHeight: '22px',
            padding: '16px',
            border: 'none',
            outline: 'none',
            resize: 'none',
          }}
        />
      </div>
    </div>
  );
};
