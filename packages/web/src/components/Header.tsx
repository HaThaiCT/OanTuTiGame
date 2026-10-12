import React from 'react';
import { Trophy, Swords, Clock, MapPin, Upload } from 'lucide-react';
import { PlayerSide, WinReason } from '@oantuti/engine';
import { LoadedReplay } from '../replay/player.js';

interface HeaderProps {
  readonly replay: LoadedReplay;
  readonly currentTurn: number;
  readonly isLive?: boolean;
  readonly onUploadReplay: (buffer: Uint8Array) => void;
  readonly onOpenNewMatch: () => void;
}

const WIN_REASON_LABELS: Record<number, string> = {
  [WinReason.EXTINCTION]: 'Extinction Win',
  [WinReason.THRONE_BREACH]: 'Throne Breach',
  [WinReason.STALEMATE]: 'Stalemate Win',
  [WinReason.TIMEOUT]: 'Timeout Forfeit',
  [WinReason.ILLEGAL_MOVE]: 'Illegal Move Forfeit',
  [WinReason.CRASH_FORFEIT]: 'Crash Forfeit',
  [WinReason.MAX_TURNS_DRAW]: 'Max Turns Reached',
  [WinReason.PROTOCOL_VIOLATION]: 'Protocol Violation',
};

export const Header: React.FC<HeaderProps> = ({
  replay,
  currentTurn,
  isLive,
  onUploadReplay,
  onOpenNewMatch,
}) => {
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const result = event.target?.result;
      if (result instanceof ArrayBuffer) {
        onUploadReplay(new Uint8Array(result));
      }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = '';
  };

  const winnerStr =
    replay.end.winner === PlayerSide.WHITE
      ? 'WHITE WINS'
      : replay.end.winner === PlayerSide.BLACK
      ? 'BLACK WINS'
      : 'DRAW';

  const reasonStr = WIN_REASON_LABELS[replay.end.reason] ?? 'In Progress';

  return (
    <header style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '12px 24px',
      backgroundColor: '#0f172a',
      borderBottom: '1px solid #1e293b',
      boxShadow: '0 4px 12px rgba(0, 0, 0, 0.4)',
    }}>
      {/* Brand & Match Details */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{
            width: '36px',
            height: '36px',
            borderRadius: '8px',
            background: 'linear-gradient(135deg, #38bdf8 0%, #f43f5e 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 0 15px rgba(56, 189, 248, 0.5)',
          }}>
            <Swords size={20} color="#0f172a" />
          </div>
          <div>
            <div style={{ fontWeight: 800, fontSize: '18px', letterSpacing: '-0.5px' }}>
              OanTuTi <span style={{ color: '#38bdf8' }}>Arena</span>
            </div>
            <div style={{ fontSize: '11px', color: '#64748b' }}>
              Battlecode Visualizer v1.0
            </div>
          </div>
        </div>

        <div style={{ width: '1px', height: '28px', backgroundColor: '#334155' }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', fontSize: '13px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#94a3b8' }}>
            <MapPin size={15} color="#38bdf8" />
            <span>Map: <strong style={{ color: '#f1f5f9' }}>{replay.init.map.mapName}</strong> ({replay.init.map.width}x{replay.init.map.height})</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#94a3b8' }}>
            <Clock size={15} color="#eab308" />
            <span>Turn: <strong style={{ color: '#f1f5f9' }}>{currentTurn} / {replay.deltas.length}</strong></span>
          </div>
        </div>
      </div>

      {/* Outcome Banner, Live Status, New Match & Replay Loader */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        {isLive && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '4px 10px',
            backgroundColor: 'rgba(239, 68, 68, 0.2)',
            border: '1px solid #ef4444',
            borderRadius: '20px',
            fontSize: '11px',
            fontWeight: 800,
            color: '#ef4444',
          }}>
            <span style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              backgroundColor: '#ef4444',
              boxShadow: '0 0 8px #ef4444',
            }} />
            <span>LIVE STREAM</span>
          </div>
        )}

        <button
          onClick={onOpenNewMatch}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            backgroundColor: '#0284c7',
            color: '#ffffff',
            border: 'none',
            borderRadius: '8px',
            padding: '8px 14px',
            fontWeight: 700,
            fontSize: '13px',
            cursor: 'pointer',
            boxShadow: '0 2px 8px rgba(2, 132, 199, 0.4)',
          }}
        >
          <Swords size={15} />
          <span>New Match</span>
        </button>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '6px 14px',
          backgroundColor: '#1e293b',
          borderRadius: '20px',
          border: '1px solid #334155',
          fontSize: '12px',
        }}>
          <Trophy size={16} color={replay.end.winner === PlayerSide.WHITE ? '#38bdf8' : '#f43f5e'} />
          <span style={{ fontWeight: 700, color: replay.end.winner === PlayerSide.WHITE ? '#38bdf8' : '#f43f5e' }}>
            {winnerStr}
          </span>
          <span style={{ color: '#64748b' }}>•</span>
          <span style={{ color: '#cbd5e1' }}>{reasonStr}</span>
        </div>

        <input
          type="file"
          accept=".oantuti"
          ref={fileInputRef}
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />

        <button
          onClick={() => fileInputRef.current?.click()}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            backgroundColor: '#0284c7',
            color: '#ffffff',
            border: 'none',
            borderRadius: '8px',
            padding: '8px 16px',
            fontWeight: 600,
            fontSize: '13px',
            cursor: 'pointer',
            boxShadow: '0 2px 8px rgba(2, 132, 199, 0.4)',
            transition: 'background-color 0.2s',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#0369a1')}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = '#0284c7')}
        >
          <Upload size={15} />
          <span>Load .oantuti Replay</span>
        </button>
      </div>
    </header>
  );
};
