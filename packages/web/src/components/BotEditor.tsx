import React from 'react';
import MonacoPackage, { EditorProps } from '@monaco-editor/react';

const MonacoEditor = (
  'default' in MonacoPackage ? MonacoPackage.default : MonacoPackage
) as React.ComponentType<EditorProps>;
import { Play, Save, RotateCcw, Bot, Swords, Loader2, CheckCircle2 } from 'lucide-react';
import { PYTHON_BOT_TEMPLATE, TYPESCRIPT_BOT_TEMPLATE } from '../editor/templates.js';
import { fetchBots, fetchMaps, createMatch, BotSummary, MapSummary } from '../api/client.js';

interface BotEditorProps {
  readonly onMatchStarted: (matchId: string) => void;
}

export const BotEditor: React.FC<BotEditorProps> = ({ onMatchStarted }) => {
  const [language, setLanguage] = React.useState<'PYTHON' | 'TYPESCRIPT'>('PYTHON');
  const [botName, setBotName] = React.useState<string>('MyPythonBot');
  const [code, setCode] = React.useState<string>(PYTHON_BOT_TEMPLATE);
  const [opponents, setOpponents] = React.useState<BotSummary[]>([]);
  const [maps, setMaps] = React.useState<MapSummary[]>([]);
  const [selectedOpponentId, setSelectedOpponentId] = React.useState<string>('');
  const [selectedMapId, setSelectedMapId] = React.useState<string>('sample-donut');
  const [isRunning, setIsRunning] = React.useState<boolean>(false);
  const [isSaved, setIsSaved] = React.useState<boolean>(false);
  const [statusMessage, setStatusMessage] = React.useState<string | null>(null);

  React.useEffect(() => {
    Promise.all([fetchBots(), fetchMaps()])
      .then(([bList, mList]) => {
        setOpponents(bList);
        setMaps(mList);

        const greedy = bList.find((b) => b.name === 'GreedyBot');
        if (greedy) setSelectedOpponentId(greedy.id);
        else if (bList.length > 0) setSelectedOpponentId(bList[0].id);

        if (mList.length > 0) setSelectedMapId(mList[0].id);
      })
      .catch((err) => {
        console.error('Failed to load bots or maps:', err);
      });
  }, []);

  const handleLanguageChange = (newLang: 'PYTHON' | 'TYPESCRIPT') => {
    setLanguage(newLang);
    if (newLang === 'PYTHON') {
      setBotName('MyPythonBot');
      setCode(PYTHON_BOT_TEMPLATE);
    } else {
      setBotName('MyTsBot');
      setCode(TYPESCRIPT_BOT_TEMPLATE);
    }
    setIsSaved(false);
  };

  const handleResetTemplate = () => {
    if (confirm('Reset code to starter template? Your edits will be replaced.')) {
      setCode(language === 'PYTHON' ? PYTHON_BOT_TEMPLATE : TYPESCRIPT_BOT_TEMPLATE);
      setIsSaved(false);
    }
  };

  const registerBotOnServer = async (): Promise<string> => {
    const res = await fetch('/api/bots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `${botName}_${Date.now().toString().slice(-4)}`,
        language,
        sourceCode: code,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Failed to save bot');
    }

    const data = await res.json();
    return data.bot.id;
  };

  const handleSaveBot = async () => {
    setStatusMessage('Saving bot to server...');
    try {
      await registerBotOnServer();
      setIsSaved(true);
      setStatusMessage('Bot saved successfully to server registry!');
      setTimeout(() => setStatusMessage(null), 3000);
    } catch (err) {
      setStatusMessage(`Save failed: ${(err as Error).message}`);
    }
  };

  const handleRunMatch = async () => {
    if (!selectedOpponentId) {
      alert('Please select an opponent bot.');
      return;
    }

    setIsRunning(true);
    setStatusMessage('Compiling & starting match...');

    try {
      // 1. Register ephemeral/current version of bot
      const myBotId = await registerBotOnServer();

      // 2. Launch match against selected opponent
      const { matchId } = await createMatch(selectedMapId, myBotId, selectedOpponentId, 300);

      setStatusMessage('Match launched! Streaming to canvas...');
      onMatchStarted(matchId);
    } catch (err) {
      alert(`Failed to launch match: ${(err as Error).message}`);
      setStatusMessage(null);
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      backgroundColor: '#0f172a',
      borderRadius: '12px',
      border: '1px solid #1e293b',
      overflow: 'hidden',
    }}>
      {/* Top Bar: Language & Controls */}
      <div style={{
        padding: '10px 14px',
        backgroundColor: '#141d2d',
        borderBottom: '1px solid #1e293b',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '10px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Bot size={16} color="#38bdf8" />
          <input
            type="text"
            value={botName}
            onChange={(e) => setBotName(e.target.value)}
            placeholder="Bot Name"
            style={{
              backgroundColor: '#0f172a',
              color: '#f8fafc',
              border: '1px solid #334155',
              borderRadius: '6px',
              padding: '4px 8px',
              fontSize: '12px',
              fontWeight: 700,
              width: '130px',
            }}
          />

          {/* Language Switcher */}
          <div style={{ display: 'flex', backgroundColor: '#0f172a', borderRadius: '6px', padding: '2px', border: '1px solid #334155' }}>
            <button
              onClick={() => handleLanguageChange('PYTHON')}
              style={{
                backgroundColor: language === 'PYTHON' ? '#0284c7' : 'transparent',
                color: language === 'PYTHON' ? '#ffffff' : '#94a3b8',
                border: 'none',
                borderRadius: '4px',
                padding: '3px 8px',
                fontSize: '11px',
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              Python
            </button>
            <button
              onClick={() => handleLanguageChange('TYPESCRIPT')}
              style={{
                backgroundColor: language === 'TYPESCRIPT' ? '#0284c7' : 'transparent',
                color: language === 'TYPESCRIPT' ? '#ffffff' : '#94a3b8',
                border: 'none',
                borderRadius: '4px',
                padding: '3px 8px',
                fontSize: '11px',
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              TypeScript
            </button>
          </div>
        </div>

        <button
          onClick={handleResetTemplate}
          title="Reset to Template"
          style={{
            background: 'none',
            border: 'none',
            color: '#64748b',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            fontSize: '11px',
          }}
        >
          <RotateCcw size={13} />
          <span>Reset</span>
        </button>
      </div>

      {/* Center: Monaco Code Editor */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <MonacoEditor
          height="100%"
          theme="vs-dark"
          language={language === 'PYTHON' ? 'python' : 'typescript'}
          value={code}
          onChange={(val: string | undefined) => setCode(val || '')}
          options={{
            minimap: { enabled: false },
            fontSize: 12,
            fontFamily: "'JetBrains Mono', monospace",
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: language === 'PYTHON' ? 4 : 2,
          }}
        />
      </div>

      {/* Bottom Bar: Match Setup & Actions */}
      <div style={{
        padding: '12px 14px',
        backgroundColor: '#141d2d',
        borderTop: '1px solid #1e293b',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      }}>
        {statusMessage && (
          <div style={{
            fontSize: '11px',
            color: isSaved ? '#4ade80' : '#38bdf8',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
          }}>
            {isSaved && <CheckCircle2 size={13} />}
            <span>{statusMessage}</span>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
          {/* Opponent Selector */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: 1 }}>
            <Swords size={14} color="#f43f5e" />
            <select
              value={selectedOpponentId}
              onChange={(e) => setSelectedOpponentId(e.target.value)}
              style={{
                flex: 1,
                backgroundColor: '#0f172a',
                color: '#f8fafc',
                border: '1px solid #334155',
                borderRadius: '6px',
                padding: '6px 8px',
                fontSize: '11px',
              }}
            >
              {opponents.map((b) => (
                <option key={b.id} value={b.id}>
                  vs {b.name} [{b.language}] ({b.elo})
                </option>
              ))}
            </select>
          </div>

          {/* Action Buttons */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <button
              onClick={handleSaveBot}
              title="Save to server registry"
              style={{
                backgroundColor: '#1e293b',
                color: '#94a3b8',
                border: '1px solid #334155',
                borderRadius: '6px',
                padding: '6px 10px',
                fontSize: '11px',
                fontWeight: 700,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
              }}
            >
              <Save size={13} />
              <span>Save</span>
            </button>

            <button
              onClick={handleRunMatch}
              disabled={isRunning}
              style={{
                backgroundColor: '#0284c7',
                color: '#ffffff',
                border: 'none',
                borderRadius: '6px',
                padding: '6px 14px',
                fontSize: '12px',
                fontWeight: 800,
                cursor: isRunning ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                boxShadow: '0 2px 8px rgba(2, 132, 199, 0.4)',
              }}
            >
              {isRunning ? <Loader2 className="animate-spin" size={13} /> : <Play size={13} />}
              <span>{isRunning ? 'Running...' : 'Run Test'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
