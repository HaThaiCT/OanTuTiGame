import React from 'react';
import { Play, Pause, SkipBack, SkipForward, ChevronLeft, ChevronRight } from 'lucide-react';

interface TimelineProps {
  readonly currentTurn: number;
  readonly totalTurns: number;
  readonly isPlaying: boolean;
  readonly playbackSpeed: number;
  readonly onPlayPause: () => void;
  readonly onStepPrev: () => void;
  readonly onStepNext: () => void;
  readonly onSeekTo: (turn: number) => void;
  readonly onSpeedChange: (speed: number) => void;
}

export const Timeline: React.FC<TimelineProps> = ({
  currentTurn,
  totalTurns,
  isPlaying,
  playbackSpeed,
  onPlayPause,
  onStepPrev,
  onStepNext,
  onSeekTo,
  onSpeedChange,
}) => {
  const speeds = [1, 2, 5, 10];

  return (
    <div style={{
      backgroundColor: '#0f172a',
      borderTop: '1px solid #1e293b',
      padding: '12px 24px',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
    }}>
      {/* Slider Scrubber */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
        <span style={{ fontSize: '12px', fontWeight: 700, color: '#38bdf8', minWidth: '40px' }}>
          T: {currentTurn}
        </span>
        <input
          type="range"
          min={0}
          max={totalTurns}
          value={currentTurn}
          onChange={(e) => onSeekTo(parseInt(e.target.value, 10))}
          style={{
            flex: 1,
            height: '6px',
            borderRadius: '4px',
            accentColor: '#38bdf8',
            cursor: 'pointer',
          }}
        />
        <span style={{ fontSize: '12px', color: '#64748b', minWidth: '40px', textAlign: 'right' }}>
          T: {totalTurns}
        </span>
      </div>

      {/* Control Buttons & Speed */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {/* Jump to start */}
          <button
            onClick={() => onSeekTo(0)}
            style={btnStyle}
            title="First Turn"
          >
            <SkipBack size={16} />
          </button>

          {/* Step prev */}
          <button
            onClick={onStepPrev}
            style={btnStyle}
            title="Previous Turn"
          >
            <ChevronLeft size={18} />
          </button>

          {/* Play / Pause */}
          <button
            onClick={onPlayPause}
            style={{
              ...btnStyle,
              backgroundColor: isPlaying ? '#e11d48' : '#0284c7',
              color: '#ffffff',
              padding: '6px 18px',
              borderRadius: '20px',
              gap: '6px',
            }}
          >
            {isPlaying ? <Pause size={16} /> : <Play size={16} />}
            <span style={{ fontSize: '12px', fontWeight: 700 }}>
              {isPlaying ? 'PAUSE' : 'PLAY'}
            </span>
          </button>

          {/* Step next */}
          <button
            onClick={onStepNext}
            style={btnStyle}
            title="Next Turn"
          >
            <ChevronRight size={18} />
          </button>

          {/* Jump to end */}
          <button
            onClick={() => onSeekTo(totalTurns)}
            style={btnStyle}
            title="Last Turn"
          >
            <SkipForward size={16} />
          </button>
        </div>

        {/* Speed Selector */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ fontSize: '12px', color: '#64748b', marginRight: '4px' }}>Speed:</span>
          {speeds.map((s) => (
            <button
              key={s}
              onClick={() => onSpeedChange(s)}
              style={{
                backgroundColor: playbackSpeed === s ? '#38bdf8' : '#1e293b',
                color: playbackSpeed === s ? '#0f172a' : '#94a3b8',
                border: '1px solid #334155',
                borderRadius: '6px',
                padding: '4px 10px',
                fontSize: '11px',
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              {s}x
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

const btnStyle: React.CSSProperties = {
  backgroundColor: '#1e293b',
  color: '#e2e8f0',
  border: '1px solid #334155',
  borderRadius: '8px',
  padding: '6px 12px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  transition: 'all 0.15s ease',
};
