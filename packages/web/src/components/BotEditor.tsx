import React from 'react';
import MonacoPackage, { EditorProps } from '@monaco-editor/react';

const MonacoEditor = (
  'default' in MonacoPackage ? MonacoPackage.default : MonacoPackage
) as React.ComponentType<EditorProps>;
import { Play, Save, RotateCcw, Bot, Swords, Loader2, CheckCircle2 } from 'lucide-react';
import { PYTHON_BOT_TEMPLATE, TYPESCRIPT_BOT_TEMPLATE, CPP_BOT_TEMPLATE } from '../editor/templates.js';
import { fetchBots, fetchMaps, fetchOwnedBots, fetchBot, fetchBotVersions, saveBot, deleteBot, createTestMatch, BotSummary, MapSummary, BotDetail, BotVersion, BotLanguage } from '../api/client.js';
import { useSession } from '../session.js';

interface BotEditorProps { readonly onMatchStarted: (matchId: string) => void }
const fieldStyle: React.CSSProperties = {background: '#0f172a', color: '#f8fafc', border: '1px solid #334155', borderRadius: 6, padding: '6px 8px', fontSize: 11};
export const BotEditor: React.FC<BotEditorProps> = ({ onMatchStarted }) => {
  const {user, loading: sessionLoading} = useSession();
  const [language, setLanguage] = React.useState<BotLanguage>('PYTHON');
  const [botName, setBotName] = React.useState('MyPythonBot');
  const [drafts, setDrafts] = React.useState<Record<BotLanguage, string>>({PYTHON: PYTHON_BOT_TEMPLATE, TYPESCRIPT: TYPESCRIPT_BOT_TEMPLATE, CPP: CPP_BOT_TEMPLATE});
  const code = drafts[language];
  const setCode = (value: string) => {setDrafts(previous => ({...previous, [language]: value})); setIsSaved(false); setDirty(true);};
  const [opponents, setOpponents] = React.useState<BotSummary[]>([]);
  const [owned, setOwned] = React.useState<BotSummary[]>([]);
  const [maps, setMaps] = React.useState<MapSummary[]>([]);
  const [selectedOpponentId, setSelectedOpponentId] = React.useState('');
  const [selectedMapId, setSelectedMapId] = React.useState('');
  const [selectedBot, setSelectedBot] = React.useState<BotDetail | null>(null);
  const [versions, setVersions] = React.useState<BotVersion[]>([]);
  const [historyVersion, setHistoryVersion] = React.useState('');
  const [isRunning, setIsRunning] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);
  const [isSaved, setIsSaved] = React.useState(false);
  const [statusMessage, setStatusMessage] = React.useState<string | null>(null);
  const mounted = React.useRef(true);
  React.useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const showError = (error: unknown) => {if (mounted.current) {setIsSaved(false); setStatusMessage(error instanceof Error ? error.message : 'Request failed');}};
  const refreshMetadata = async () => {
    const [all, mine] = await Promise.all([fetchBots(), fetchOwnedBots()]);
    if (!mounted.current) return;
    setOpponents(all); setOwned(mine);
    setSelectedOpponentId(current => all.some(bot => bot.id === current) ? current : all[0]?.id ?? '');
  };
  React.useEffect(() => {
    let active = true;
    Promise.all([fetchBots(), fetchMaps(), user ? fetchOwnedBots() : Promise.resolve([])])
      .then(([bots, loadedMaps, mine]) => {
        if (!active) return;
        setOpponents(bots); setMaps(loadedMaps); setOwned(mine);
        setSelectedOpponentId(bots.find(bot => bot.name === 'GreedyBot')?.id ?? bots[0]?.id ?? '');
        setSelectedMapId(loadedMaps[0]?.id ?? '');
      }).catch(error => {if (active) showError(error);});
    return () => {active = false;};
  }, [user?.id]);
  const canReplace = () => !dirty || window.confirm('Replace your unsaved bot draft?');
  const applySource = (source: {name: string; language: BotLanguage; sourceCode: string}) => {
    setBotName(source.name); setLanguage(source.language);
    setDrafts({PYTHON: PYTHON_BOT_TEMPLATE, TYPESCRIPT: TYPESCRIPT_BOT_TEMPLATE, CPP: CPP_BOT_TEMPLATE, [source.language]: source.sourceCode});
    setIsSaved(false);
  };
  const handleSelectBot = async (id: string) => {
    if (!canReplace()) return;
    if (!id) {
      setSelectedBot(null); setVersions([]); setHistoryVersion(''); setLanguage('PYTHON'); setBotName('MyPythonBot');
      setDrafts({PYTHON: PYTHON_BOT_TEMPLATE, TYPESCRIPT: TYPESCRIPT_BOT_TEMPLATE, CPP: CPP_BOT_TEMPLATE}); setDirty(false); setIsSaved(false); setStatusMessage(null); return;
    }
    setBusy(true); setStatusMessage(null);
    try {
      const [bot, history] = await Promise.all([fetchBot(id), fetchBotVersions(id)]);
      if (!mounted.current) return;
      setSelectedBot(bot); setVersions(history); setHistoryVersion(String(bot.version)); applySource(bot); setDirty(false);
    } catch (error) {showError(error);} finally {if (mounted.current) setBusy(false);}
  };
  const handleHistory = (value: string) => {
    const version = versions.find(item => String(item.version) === value);
    if (!version || !canReplace()) return;
    applySource(version); setHistoryVersion(value); setDirty(true);
    setStatusMessage('Historical source loaded. Save creates a new version.');
  };
  const handleLanguageChange = (value: BotLanguage) => {setLanguage(value); setDirty(true); setIsSaved(false);};
  const handleResetTemplate = () => {if (window.confirm('Reset code to starter template? Your edits will be replaced.')) setCode(language === 'PYTHON' ? PYTHON_BOT_TEMPLATE : language === 'CPP' ? CPP_BOT_TEMPLATE : TYPESCRIPT_BOT_TEMPLATE);};
  const handleSaveBot = async () => {
    if (!user) {setStatusMessage('Sign in to save bots.'); return;}
    setBusy(true); setIsSaved(false); setStatusMessage('Saving bot…');
    try {
      const bot = await saveBot({name: botName, language, sourceCode: code}, selectedBot ?? undefined);
      if (!mounted.current) return;
      setSelectedBot(bot); setDirty(false); setHistoryVersion(String(bot.version));
      const history = await fetchBotVersions(bot.id);
      if (!mounted.current) return;
      setVersions(history); await refreshMetadata();
      if (mounted.current) {setIsSaved(true); setStatusMessage('Saved ' + bot.name + ' · version ' + bot.version);}
    } catch (error) {showError(error);} finally {if (mounted.current) setBusy(false);}
  };
  const handleDelete = async () => {
    if (!selectedBot || !window.confirm('Delete bot "' + selectedBot.name + '"? Existing match history is retained.')) return;
    setBusy(true); setIsSaved(false); setStatusMessage(null);
    try {
      await deleteBot(selectedBot.id);
      if (!mounted.current) return;
      setDirty(false); setSelectedBot(null); setVersions([]); setHistoryVersion('');
      setBotName('MyPythonBot'); setLanguage('PYTHON'); setDrafts({PYTHON: PYTHON_BOT_TEMPLATE, TYPESCRIPT: TYPESCRIPT_BOT_TEMPLATE, CPP: CPP_BOT_TEMPLATE});
      await refreshMetadata(); if (mounted.current) setStatusMessage('Bot deleted. Match history retained.');
    } catch (error) {showError(error);} finally {if (mounted.current) setBusy(false);}
  };
  const handleRunMatch = async () => {
    if (!user) {setStatusMessage('Sign in to run test matches.'); return;}
    setIsRunning(true); setIsSaved(false); setStatusMessage('Compiling & starting test…');
    try {
      const {matchId} = await createTestMatch({mapId: selectedMapId, opponentBotId: selectedOpponentId, language, sourceCode: code, maxTurns: 300});
      if (!mounted.current) return;
      setStatusMessage('Test launched! Streaming to canvas…'); onMatchStarted(matchId);
    } catch (error) {showError(error);} finally {if (mounted.current) setIsRunning(false);}
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
      <div style={{display: 'flex', flexWrap: 'wrap', gap: 6, padding: '8px 14px', background: '#141d2d'}}>
        <select aria-label="Owned bot" value={selectedBot?.id ?? ''} disabled={!user || busy || isRunning} onChange={event => void handleSelectBot(event.target.value)} style={{...fieldStyle, flex: 1}}>
          <option value="">New Bot</option>{owned.map(bot => <option key={bot.id} value={bot.id}>{bot.name} · v{bot.version}</option>)}
        </select>
        <button disabled={busy || isRunning} onClick={() => void handleSelectBot('')} style={fieldStyle}>New Bot</button>
        {selectedBot && <><select aria-label="Bot history" value={historyVersion} disabled={busy || isRunning} onChange={event => handleHistory(event.target.value)} style={fieldStyle}>
          {versions.map(version => <option key={version.version} value={String(version.version)}>Version {version.version}</option>)}
        </select><button disabled={busy || isRunning} onClick={handleDelete} style={{...fieldStyle, color: '#fca5a5'}}>Delete</button></>}
      </div>
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
            aria-label="Bot name"
            disabled={busy}
            onChange={(e) => {setBotName(e.target.value); setDirty(true); setIsSaved(false);}}
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
              disabled={busy}
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
              disabled={busy}
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
            <button
              disabled={busy}
              onClick={() => handleLanguageChange('CPP')}
              style={{
                backgroundColor: language === 'CPP' ? '#0284c7' : 'transparent',
                color: language === 'CPP' ? '#ffffff' : '#94a3b8',
                border: 'none',
                borderRadius: '4px',
                padding: '3px 8px',
                fontSize: '11px',
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              C++
            </button>
          </div>
        </div>

        <button
          onClick={handleResetTemplate}
          disabled={busy}
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
          language={language === 'PYTHON' ? 'python' : language === 'CPP' ? 'cpp' : 'typescript'}
          value={code}
          onChange={(val: string | undefined) => setCode(val || '')}
          options={{
            readOnly: busy,
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
        {!user && <div style={{fontSize: 11, color: '#fbbf24'}}>{sessionLoading ? 'Checking session…' : 'Sign in using the account menu to save bots or run tests. Anonymous editing is available.'}</div>}
        <label style={{fontSize: 11, color: '#94a3b8'}}>Map <select aria-label="Test map" value={selectedMapId} onChange={event => setSelectedMapId(event.target.value)} style={fieldStyle}>
          {!maps.length && <option value="">No maps available</option>}{maps.map(map => <option key={map.id} value={map.id}>{map.name} ({map.width}×{map.height})</option>)}
        </select></label>
        {statusMessage && (
          <div role="status" style={{
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
              aria-label="Test opponent"
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
              disabled={!user || sessionLoading || busy || isRunning || !botName.trim()}
              title="Save owned bot version"
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
              disabled={!user || sessionLoading || busy || isRunning || !selectedOpponentId || !selectedMapId}
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
