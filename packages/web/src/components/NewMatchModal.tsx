import React from 'react';
import { X, Swords, MapPin, Bot, Play, Loader2 } from 'lucide-react';
import { fetchMaps, fetchBots, createMatch, MapSummary, BotSummary } from '../api/client.js';

interface NewMatchModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onMatchStarted: (matchId: string) => void;
}

export const NewMatchModal: React.FC<NewMatchModalProps> = ({
  isOpen,
  onClose,
  onMatchStarted,
}) => {
  const [maps, setMaps] = React.useState<MapSummary[]>([]);
  const [bots, setBots] = React.useState<BotSummary[]>([]);
  const [selectedMap, setSelectedMap] = React.useState<string>('sample-donut');
  const [whiteBotId, setWhiteBotId] = React.useState<string>('');
  const [blackBotId, setBlackBotId] = React.useState<string>('');
  const [maxTurns, setMaxTurns] = React.useState<number>(300);
  const [isLoading, setIsLoading] = React.useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = React.useState<boolean>(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!isOpen) return;

    setIsLoading(true);
    setErrorMessage(null);

    Promise.all([fetchMaps(), fetchBots()])
      .then(([mList, bList]) => {
        setMaps(mList);
        setBots(bList);

        if (mList.length > 0 && !selectedMap) {
          setSelectedMap(mList[0].id);
        }

        const greedy = bList.find((b) => b.name === 'GreedyBot');
        const random = bList.find((b) => b.name === 'RandomBot');

        if (greedy) setWhiteBotId(greedy.id);
        else if (bList.length > 0) setWhiteBotId(bList[0].id);

        if (random) setBlackBotId(random.id);
        else if (bList.length > 1) setBlackBotId(bList[1].id);
        else if (bList.length > 0) setBlackBotId(bList[0].id);
      })
      .catch((err) => {
        setErrorMessage((err as Error).message);
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedMap || !whiteBotId || !blackBotId) {
      setErrorMessage('Please select map and both bots.');
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const { matchId } = await createMatch(selectedMap, whiteBotId, blackBotId, maxTurns);
      onMatchStarted(matchId);
      onClose();
    } catch (err) {
      setErrorMessage((err as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.75)',
      backdropFilter: 'blur(4px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000,
      padding: '16px',
    }}>
      <div style={{
        backgroundColor: '#0f172a',
        border: '1px solid #1e293b',
        borderRadius: '16px',
        width: '100%',
        maxWidth: '520px',
        boxShadow: '0 20px 40px rgba(0, 0, 0, 0.6), 0 0 20px rgba(56, 189, 248, 0.15)',
        overflow: 'hidden',
      }}>
        {/* Modal Header */}
        <div style={{
          padding: '16px 20px',
          borderBottom: '1px solid #1e293b',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{
              width: '32px',
              height: '32px',
              borderRadius: '8px',
              backgroundColor: '#0284c7',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <Swords size={18} color="#ffffff" />
            </div>
            <div>
              <div style={{ fontWeight: 800, fontSize: '16px', color: '#f1f5f9' }}>
                Start Live Match
              </div>
              <div style={{ fontSize: '11px', color: '#64748b' }}>
                Spawn headless match & stream binary WebSocket frames
              </div>
            </div>
          </div>

          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: '#64748b',
              cursor: 'pointer',
              padding: '4px',
              borderRadius: '6px',
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Modal Body */}
        {isLoading ? (
          <div style={{ padding: '40px', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '10px', color: '#94a3b8' }}>
            <Loader2 className="animate-spin" size={20} />
            <span>Loading maps & bots from server...</span>
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {errorMessage && (
              <div style={{
                backgroundColor: 'rgba(239, 68, 68, 0.15)',
                border: '1px solid #ef4444',
                color: '#f87171',
                padding: '10px 14px',
                borderRadius: '8px',
                fontSize: '12px',
              }}>
                {errorMessage}
              </div>
            )}

            {/* Map Selection */}
            <div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 700, color: '#94a3b8', marginBottom: '6px' }}>
                <MapPin size={14} color="#38bdf8" />
                Select Battle Map
              </label>
              <select
                value={selectedMap}
                onChange={(e) => setSelectedMap(e.target.value)}
                style={selectStyle}
              >
                {maps.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.width}x{m.height} • {m.validTilesCount} tiles)
                  </option>
                ))}
              </select>
            </div>

            {/* White Bot */}
            <div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 700, color: '#38bdf8', marginBottom: '6px' }}>
                <Bot size={14} color="#38bdf8" />
                White Side (First Mover)
              </label>
              <select
                value={whiteBotId}
                onChange={(e) => setWhiteBotId(e.target.value)}
                style={selectStyle}
              >
                {bots.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} [{b.language}] • ELO: {b.elo}
                  </option>
                ))}
              </select>
            </div>

            {/* Black Bot */}
            <div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 700, color: '#f43f5e', marginBottom: '6px' }}>
                <Bot size={14} color="#f43f5e" />
                Black Side (Second Mover)
              </label>
              <select
                value={blackBotId}
                onChange={(e) => setBlackBotId(e.target.value)}
                style={selectStyle}
              >
                {bots.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} [{b.language}] • ELO: {b.elo}
                  </option>
                ))}
              </select>
            </div>

            {/* Max Turns */}
            <div>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: '#94a3b8', marginBottom: '6px' }}>
                Max Turns Budget (Default: 300)
              </label>
              <input
                type="number"
                min={10}
                max={500}
                value={maxTurns}
                onChange={(e) => setMaxTurns(parseInt(e.target.value, 10) || 300)}
                style={{ ...selectStyle, width: '100%' }}
              />
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '10px' }}>
              <button
                type="button"
                onClick={onClose}
                disabled={isSubmitting}
                style={{
                  backgroundColor: '#1e293b',
                  color: '#94a3b8',
                  border: '1px solid #334155',
                  borderRadius: '8px',
                  padding: '10px 16px',
                  fontWeight: 600,
                  fontSize: '13px',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>

              <button
                type="submit"
                disabled={isSubmitting}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  backgroundColor: '#0284c7',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '8px',
                  padding: '10px 20px',
                  fontWeight: 700,
                  fontSize: '13px',
                  cursor: isSubmitting ? 'not-allowed' : 'pointer',
                  boxShadow: '0 4px 12px rgba(2, 132, 199, 0.4)',
                }}
              >
                {isSubmitting ? <Loader2 size={16} /> : <Play size={16} />}
                <span>{isSubmitting ? 'Starting...' : 'Launch Live Match'}</span>
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};

const selectStyle: React.CSSProperties = {
  width: '100%',
  backgroundColor: '#141d2d',
  color: '#f1f5f9',
  border: '1px solid #334155',
  borderRadius: '8px',
  padding: '10px 12px',
  fontSize: '13px',
  fontFamily: 'inherit',
  outline: 'none',
  boxSizing: 'border-box',
};
