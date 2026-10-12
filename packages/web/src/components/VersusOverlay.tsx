import React from 'react';
import { Swords, MapPin } from 'lucide-react';

export interface VersusOverlayProps {
  readonly whiteBotName: string;
  readonly blackBotName: string;
  readonly whiteElo?: number;
  readonly blackElo?: number;
  readonly mapName?: string;
  readonly durationMs?: number;
  readonly onDismiss: () => void;
}

export const VersusOverlay: React.FC<VersusOverlayProps> = ({
  whiteBotName,
  blackBotName,
  whiteElo,
  blackElo,
  mapName,
  durationMs = 1500,
  onDismiss,
}) => {
  React.useEffect(() => {
    const timer = setTimeout(() => {
      onDismiss();
    }, durationMs);

    const handleKey = () => {
      onDismiss();
    };

    window.addEventListener('keydown', handleKey);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', handleKey);
    };
  }, [durationMs, onDismiss]);

  return (
    <div
      onClick={onDismiss}
      style={{
        position: 'absolute',
        inset: 0,
        backgroundColor: 'rgba(6, 10, 18, 0.88)',
        backdropFilter: 'blur(8px)',
        zIndex: 50,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        userSelect: 'none',
        animation: 'fadeIn 0.2s ease-out',
      }}
    >
      {/* Top Map Banner */}
      {mapName && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '6px 16px',
            backgroundColor: '#0f172a',
            border: '1px solid #1e293b',
            borderRadius: '20px',
            marginBottom: '32px',
            boxShadow: '0 0 15px rgba(6, 182, 212, 0.15)',
          }}
        >
          <MapPin size={15} color="#06b6d4" />
          <span style={{ fontSize: '13px', fontWeight: 800, color: '#f8fafc', letterSpacing: '0.5px' }}>
            {mapName}
          </span>
        </div>
      )}

      {/* Versus Cards Container */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '28px',
          maxWidth: '850px',
          width: '90%',
          justifyContent: 'center',
        }}
      >
        {/* White Fighter Card */}
        <div
          style={{
            flex: 1,
            backgroundColor: '#090f1d',
            border: '2px solid #06b6d4',
            borderRadius: '16px',
            padding: '24px 20px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            textAlign: 'center',
            boxShadow: '0 0 25px rgba(6, 182, 212, 0.35)',
            transform: 'perspective(600px) rotateY(4deg)',
          }}
        >
          <div
            style={{
              width: '64px',
              height: '64px',
              borderRadius: '50%',
              background: 'radial-gradient(circle, #38bdf8, #0284c7)',
              border: '3px solid #e0f2fe',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '28px',
              boxShadow: '0 0 20px #06b6d4',
              marginBottom: '14px',
            }}
          >
            ✊
          </div>
          <div style={{ fontSize: '11px', fontWeight: 800, color: '#06b6d4', textTransform: 'uppercase', letterSpacing: '1px' }}>
            WHITE SIDE
          </div>
          <div style={{ fontSize: '20px', fontWeight: 900, color: '#f8fafc', margin: '6px 0', textShadow: '0 0 12px rgba(6, 182, 212, 0.6)' }}>
            {whiteBotName}
          </div>
          <div
            style={{
              fontSize: '12px',
              fontWeight: 800,
              backgroundColor: '#162238',
              color: '#38bdf8',
              padding: '4px 12px',
              borderRadius: '12px',
              border: '1px solid #0ea5e9',
            }}
          >
            {whiteElo !== undefined ? `${whiteElo} ELO` : 'UNRATED'}
          </div>
        </div>

        {/* Center Glowing VS Badge */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '6px',
            zIndex: 10,
          }}
        >
          <div
            style={{
              width: '60px',
              height: '60px',
              borderRadius: '50%',
              backgroundColor: '#1e293b',
              border: '2px solid #eab308',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 0 25px rgba(234, 179, 8, 0.5)',
            }}
          >
            <Swords size={28} color="#eab308" />
          </div>
          <span style={{ fontSize: '18px', fontWeight: 900, color: '#eab308', letterSpacing: '2px', textShadow: '0 0 10px rgba(234, 179, 8, 0.7)' }}>
            VS
          </span>
        </div>

        {/* Black Fighter Card */}
        <div
          style={{
            flex: 1,
            backgroundColor: '#090f1d',
            border: '2px solid #f43f5e',
            borderRadius: '16px',
            padding: '24px 20px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            textAlign: 'center',
            boxShadow: '0 0 25px rgba(244, 63, 94, 0.35)',
            transform: 'perspective(600px) rotateY(-4deg)',
          }}
        >
          <div
            style={{
              width: '64px',
              height: '64px',
              borderRadius: '50%',
              background: 'radial-gradient(circle, #fb7185, #be123c)',
              border: '3px solid #ffe4e6',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '28px',
              boxShadow: '0 0 20px #f43f5e',
              marginBottom: '14px',
            }}
          >
            ✋
          </div>
          <div style={{ fontSize: '11px', fontWeight: 800, color: '#f43f5e', textTransform: 'uppercase', letterSpacing: '1px' }}>
            BLACK SIDE
          </div>
          <div style={{ fontSize: '20px', fontWeight: 900, color: '#f8fafc', margin: '6px 0', textShadow: '0 0 12px rgba(244, 63, 94, 0.6)' }}>
            {blackBotName}
          </div>
          <div
            style={{
              fontSize: '12px',
              fontWeight: 800,
              backgroundColor: '#271420',
              color: '#fb7185',
              padding: '4px 12px',
              borderRadius: '12px',
              border: '1px solid #e11d48',
            }}
          >
            {blackElo !== undefined ? `${blackElo} ELO` : 'UNRATED'}
          </div>
        </div>
      </div>

      {/* Dismiss prompt hint */}
      <div
        style={{
          marginTop: '36px',
          fontSize: '12px',
          color: '#64748b',
          letterSpacing: '0.5px',
          animation: 'pulse 1.5s infinite',
        }}
      >
        Click or press any key to skip
      </div>
    </div>
  );
};
