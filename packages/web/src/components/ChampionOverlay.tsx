import React from 'react';
import { Trophy, Award, X, Sparkles, Flame } from 'lucide-react';
import confetti from 'canvas-confetti';
import { TournamentStanding } from '../api/client.js';

export interface ChampionOverlayProps {
  readonly champion: TournamentStanding;
  readonly runnerUp?: TournamentStanding;
  readonly thirdPlace?: TournamentStanding;
  readonly tournamentName: string;
  readonly onDismiss: () => void;
}

export const ChampionOverlay: React.FC<ChampionOverlayProps> = ({
  champion,
  runnerUp,
  thirdPlace,
  tournamentName,
  onDismiss,
}) => {
  React.useEffect(() => {
    try {
      confetti({
        particleCount: 150,
        spread: 90,
        origin: { y: 0.5 },
      });
      setTimeout(() => {
        try {
          confetti({
            particleCount: 100,
            angle: 60,
            spread: 60,
            origin: { x: 0 },
          });
          confetti({
            particleCount: 100,
            angle: 120,
            spread: 60,
            origin: { x: 1 },
          });
        } catch {}
      }, 400);
    } catch {}
  }, []);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(6, 10, 18, 0.92)',
        backdropFilter: 'blur(10px)',
        zIndex: 100,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
        animation: 'fadeIn 0.3s ease-out',
      }}
    >
      <div
        style={{
          backgroundColor: '#090f1d',
          border: '2px solid #eab308',
          borderRadius: '20px',
          maxWidth: '560px',
          width: '100%',
          padding: '32px 24px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
          boxShadow: '0 0 50px rgba(234, 179, 8, 0.35)',
          position: 'relative',
        }}
      >
        {/* Close Button */}
        <button
          onClick={onDismiss}
          style={{
            position: 'absolute',
            top: '16px',
            right: '16px',
            background: 'none',
            border: 'none',
            color: '#64748b',
            cursor: 'pointer',
            padding: '4px',
          }}
        >
          <X size={20} />
        </button>

        {/* Crown & Trophy Icon */}
        <div
          style={{
            width: '84px',
            height: '84px',
            borderRadius: '50%',
            backgroundColor: '#1e293b',
            border: '3px solid #eab308',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 0 35px rgba(234, 179, 8, 0.6)',
            marginBottom: '16px',
          }}
        >
          <Trophy size={46} color="#eab308" />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#eab308', fontSize: '12px', fontWeight: 900, letterSpacing: '2px', textTransform: 'uppercase' }}>
          <Sparkles size={14} />
          <span>LỄ VINH DANH QUÁN QUÂN</span>
          <Sparkles size={14} />
        </div>

        <div style={{ fontSize: '13px', color: '#94a3b8', marginTop: '4px' }}>
          {tournamentName}
        </div>

        {/* Champion Showcase Card */}
        <div
          style={{
            width: '100%',
            backgroundColor: '#141d2d',
            border: '2px solid #eab308',
            borderRadius: '14px',
            padding: '18px 20px',
            margin: '20px 0',
            boxShadow: '0 0 20px rgba(234, 179, 8, 0.2)',
          }}
        >
          <div style={{ fontSize: '11px', fontWeight: 800, color: '#eab308', textTransform: 'uppercase' }}>
            👑 NHÀ VÔ ĐỊCH GIẢI ĐẤU
          </div>
          <div style={{ fontSize: '26px', fontWeight: 900, color: '#f8fafc', margin: '4px 0', textShadow: '0 0 16px rgba(234, 179, 8, 0.6)' }}>
            {champion.botName}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', marginTop: '6px' }}>
            <span style={{ fontSize: '11px', backgroundColor: '#0f172a', color: '#38bdf8', padding: '2px 8px', borderRadius: '4px', fontWeight: 800 }}>
              {champion.language}
            </span>
            <span style={{ fontSize: '13px', fontWeight: 800, color: '#4ade80' }}>
              {champion.points.toFixed(1)} Điểm ({champion.wins} Thắng)
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px', fontWeight: 800, color: '#f59e0b' }}>
              <Flame size={14} />
              {champion.elo} ELO
            </span>
          </div>
        </div>

        {/* Podium for Runner-up and 3rd place */}
        {(runnerUp || thirdPlace) && (
          <div style={{ width: '100%', display: 'grid', gridTemplateColumns: thirdPlace ? '1fr 1fr' : '1fr', gap: '10px', marginBottom: '20px' }}>
            {runnerUp && (
              <div style={{ backgroundColor: '#111827', border: '1px solid #94a3b8', borderRadius: '10px', padding: '10px 12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: '#94a3b8', fontSize: '11px', fontWeight: 800 }}>
                  <Award size={14} color="#94a3b8" />
                  <span>Á QUÂN (#2)</span>
                </div>
                <div style={{ fontSize: '14px', fontWeight: 800, color: '#f1f5f9', marginTop: '2px' }}>
                  {runnerUp.botName}
                </div>
                <div style={{ fontSize: '11px', color: '#64748b' }}>
                  {runnerUp.points.toFixed(1)} pts • {runnerUp.elo} ELO
                </div>
              </div>
            )}

            {thirdPlace && (
              <div style={{ backgroundColor: '#111827', border: '1px solid #b45309', borderRadius: '10px', padding: '10px 12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: '#b45309', fontSize: '11px', fontWeight: 800 }}>
                  <Award size={14} color="#b45309" />
                  <span>HẠNG BA (#3)</span>
                </div>
                <div style={{ fontSize: '14px', fontWeight: 800, color: '#f1f5f9', marginTop: '2px' }}>
                  {thirdPlace.botName}
                </div>
                <div style={{ fontSize: '11px', color: '#64748b' }}>
                  {thirdPlace.points.toFixed(1)} pts • {thirdPlace.elo} ELO
                </div>
              </div>
            )}
          </div>
        )}

        <button
          onClick={onDismiss}
          style={{
            backgroundColor: '#eab308',
            color: '#0f172a',
            border: 'none',
            borderRadius: '8px',
            padding: '10px 28px',
            fontSize: '13px',
            fontWeight: 900,
            cursor: 'pointer',
            boxShadow: '0 4px 15px rgba(234, 179, 8, 0.4)',
          }}
        >
          Hoàn Tất & Bế Mạc Giải
        </button>
      </div>
    </div>
  );
};
