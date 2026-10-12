import React from 'react';
import { X, Trophy, MapPin, Bot, Play, Loader2, CheckSquare, Square } from 'lucide-react';
import { fetchMaps, fetchBots, createTournament, MapSummary, BotSummary } from '../api/client.js';

interface TournamentModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onTournamentStarted: (tournamentId: string) => void;
}

export const TournamentModal: React.FC<TournamentModalProps> = ({
  isOpen,
  onClose,
  onTournamentStarted,
}) => {
  const [name, setName] = React.useState<string>('OanTuTi Arena Championship');
  const [format, setFormat] = React.useState<'ROUND_ROBIN' | 'SWISS'>('ROUND_ROBIN');
  const [maps, setMaps] = React.useState<MapSummary[]>([]);
  const [bots, setBots] = React.useState<BotSummary[]>([]);
  const [selectedMapId, setSelectedMapId] = React.useState<string>('sample-donut');
  const [selectedBotIds, setSelectedBotIds] = React.useState<string[]>([]);
  const [doubleRound, setDoubleRound] = React.useState<boolean>(false);
  const [maxTurns, setMaxTurns] = React.useState<number>(150);
  const [registrationOnly, setRegistrationOnly] = React.useState(true);
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

        if (mList.length > 0) setSelectedMapId(mList[0].id);
        // Default select all bots
        setSelectedBotIds(bList.map((b) => b.id));
      })
      .catch((err) => {
        setErrorMessage((err as Error).message);
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [isOpen]);

  if (!isOpen) return null;

  const toggleBot = (botId: string) => {
    setSelectedBotIds((prev) =>
      prev.includes(botId) ? prev.filter((id) => id !== botId) : [...prev, botId]
    );
  };

  const handleSelectAll = () => {
    if (selectedBotIds.length === bots.length) {
      setSelectedBotIds([]);
    } else {
      setSelectedBotIds(bots.map((b) => b.id));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!registrationOnly && selectedBotIds.length < 2) {
      setErrorMessage('Tournament requires at least 2 participating bots');
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const tour = await createTournament({
        name,
        format,
        mapId: selectedMapId,
        botIds: selectedBotIds,
        maxTurns,
        doubleRound,
        registrationOnly,
      });

      onTournamentStarted(tour.id);
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
        maxWidth: '540px',
        maxHeight: '90vh',
        boxShadow: '0 20px 40px rgba(0, 0, 0, 0.6), 0 0 20px rgba(234, 179, 8, 0.15)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          padding: '16px 20px',
          borderBottom: '1px solid #1e293b',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          backgroundColor: '#141d2d',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{
              width: '34px',
              height: '34px',
              borderRadius: '8px',
              backgroundColor: '#eab308',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 0 12px rgba(234, 179, 8, 0.4)',
            }}>
              <Trophy size={18} color="#0f172a" />
            </div>
            <div>
              <div style={{ fontWeight: 800, fontSize: '16px', color: '#f1f5f9' }}>
                Create Automated Tournament
              </div>
              <div style={{ fontSize: '11px', color: '#64748b' }}>
                Automated Round-Robin matchmaking & ELO tracking
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
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        {isLoading ? (
          <div style={{ padding: '40px', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '10px', color: '#94a3b8' }}>
            <Loader2 className="animate-spin" size={20} />
            <span>Loading maps and bots...</span>
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px', overflowY: 'auto' }}>
          <label style={{padding:12,color:'#38bdf8'}}><input type="checkbox" checked={registrationOnly} onChange={event=>setRegistrationOnly(event.target.checked)}/> Mở đăng ký — thí sinh tự nộp bot, người tổ chức chốt sau</label>
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

            {/* Name */}
            <div>
              <label style={labelStyle}>Tournament Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                style={inputStyle}
                required
              />
            </div>

            {/* Map & Format */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div>
                <label style={labelStyle}>
                  <MapPin size={13} color="#38bdf8" />
                  <span>Battle Map</span>
                </label>
                <select
                  value={selectedMapId}
                  onChange={(e) => setSelectedMapId(e.target.value)}
                  style={inputStyle}
                >
                  {maps.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({m.width}x{m.height})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label style={labelStyle}>
                  <Trophy size={13} color="#eab308" />
                  <span>Format</span>
                </label>
                <select
                  value={format}
                  onChange={(e) => setFormat(e.target.value as 'ROUND_ROBIN' | 'SWISS')}
                  style={inputStyle}
                >
                  <option value="ROUND_ROBIN">Round-Robin (Vòng tròn)</option>
                  <option value="SWISS">Swiss (Hệ Thụy Sĩ)</option>
                </select>
              </div>
            </div>

            {/* Bot Selection List */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <label style={labelStyle}>
                  <Bot size={13} color="#38bdf8" />
                  <span>Participating Bots ({selectedBotIds.length} / {bots.length})</span>
                </label>
                <button
                  type="button"
                  onClick={handleSelectAll}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#38bdf8',
                    cursor: 'pointer',
                    fontSize: '11px',
                    fontWeight: 700,
                  }}
                >
                  {selectedBotIds.length === bots.length ? 'Deselect All' : 'Select All'}
                </button>
              </div>

              <div style={{
                maxHeight: '160px',
                overflowY: 'auto',
                backgroundColor: '#141d2d',
                border: '1px solid #334155',
                borderRadius: '8px',
                padding: '6px',
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
              }}>
                {bots.map((b) => {
                  const isChecked = selectedBotIds.includes(b.id);
                  return (
                    <div
                      key={b.id}
                      onClick={() => toggleBot(b.id)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '6px 10px',
                        borderRadius: '6px',
                        backgroundColor: isChecked ? 'rgba(56, 189, 248, 0.12)' : 'transparent',
                        cursor: 'pointer',
                        fontSize: '12px',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        {isChecked ? (
                          <CheckSquare size={16} color="#38bdf8" />
                        ) : (
                          <Square size={16} color="#64748b" />
                        )}
                        <span style={{ fontWeight: 700, color: '#f1f5f9' }}>{b.name}</span>
                        <span style={{ fontSize: '10px', color: '#94a3b8', backgroundColor: '#0f172a', padding: '1px 5px', borderRadius: '4px' }}>
                          {b.language}
                        </span>
                      </div>
                      <span style={{ fontSize: '11px', fontWeight: 800, color: '#38bdf8' }}>
                        {b.elo} ELO
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Options */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: '#cbd5e1', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={doubleRound}
                  onChange={(e) => setDoubleRound(e.target.checked)}
                  style={{ accentColor: '#38bdf8' }}
                />
                <span>Double Round (Lượt đi & lượt về đổi phe Trắng/Đen)</span>
              </label>

              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ fontSize: '11px', color: '#94a3b8' }}>Max Turns:</span>
                <input
                  type="number"
                  min={50}
                  max={300}
                  value={maxTurns}
                  onChange={(e) => setMaxTurns(parseInt(e.target.value, 10) || 150)}
                  style={{
                    backgroundColor: '#141d2d',
                    color: '#f1f5f9',
                    border: '1px solid #334155',
                    borderRadius: '6px',
                    padding: '4px 8px',
                    fontSize: '11px',
                    width: '60px',
                  }}
                />
              </div>
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
                disabled={isSubmitting || (!registrationOnly && selectedBotIds.length < 2)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  backgroundColor: '#eab308',
                  color: '#0f172a',
                  border: 'none',
                  borderRadius: '8px',
                  padding: '10px 20px',
                  fontWeight: 800,
                  fontSize: '13px',
                  cursor: isSubmitting || selectedBotIds.length < 2 ? 'not-allowed' : 'pointer',
                  boxShadow: '0 4px 12px rgba(234, 179, 8, 0.35)',
                }}
              >
                {isSubmitting ? <Loader2 size={16} /> : <Play size={16} />}
                <span>{isSubmitting ? 'Starting...' : registrationOnly ? 'Mở đăng ký giải' : 'Launch Tournament'}</span>
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};

const labelStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  fontSize: '12px',
  fontWeight: 700,
  color: '#94a3b8',
  marginBottom: '6px',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  backgroundColor: '#141d2d',
  color: '#f1f5f9',
  border: '1px solid #334155',
  borderRadius: '8px',
  padding: '8px 12px',
  fontSize: '13px',
  fontFamily: 'inherit',
  outline: 'none',
  boxSizing: 'border-box',
};
