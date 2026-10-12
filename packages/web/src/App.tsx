import React from 'react';
import { decodeValidTilesBitmask } from '@oantuti/protocol';
import { Header } from './components/Header.js';
import { Timeline } from './components/Timeline.js';
import { PieceCounter } from './components/PieceCounter.js';
import { TurnLogs } from './components/TurnLogs.js';
import { CanvasViewport } from './components/CanvasViewport.js';
import { NewMatchModal } from './components/NewMatchModal.js';
import { TournamentModal } from './components/TournamentModal.js';
import { BotEditor } from './components/BotEditor.js';
import { LeaderboardView } from './components/LeaderboardView.js';
import { LoadedReplay, parseReplayBinary } from './replay/player.js';
import { generateDefaultMatch } from './replay/mock-generator.js';
import { subscribeLiveMatch } from './api/client.js';
import { Code2, ScrollText, Trophy } from 'lucide-react';
import { useSession } from './session.js';
import confetti from 'canvas-confetti';
import { soundManager } from './audio/sound-effects.js';
import { VersusOverlay } from './components/VersusOverlay.js';
import { useKeyboardControls } from './hooks/useKeyboardControls.js';
export const App: React.FC = () => {
  const {user} = useSession();
  const [replay, setReplay] = React.useState<LoadedReplay>(() => generateDefaultMatch());
  const [currentTurn, setCurrentTurn] = React.useState<number>(0);
  const [isPlaying, setIsPlaying] = React.useState<boolean>(false);
  const [playbackSpeed, setPlaybackSpeed] = React.useState<number>(1);
  const [isModalOpen, setIsModalOpen] = React.useState<boolean>(false);
  const [isTourModalOpen, setIsTourModalOpen] = React.useState<boolean>(false);
  const [activeTournamentId, setActiveTournamentId] = React.useState<string | undefined>();
  const [isLiveStream, setIsLiveStream] = React.useState<boolean>(false);
  const [rightTab, setRightTab] = React.useState<'EDITOR' | 'LOGS' | 'LEADERBOARD'>('LOGS');
  const [isMuted, setIsMuted] = React.useState<boolean>(() => soundManager.isMuted());
  const [isTheaterMode, setIsTheaterMode] = React.useState<boolean>(false);
  const [versusOverlayData, setVersusOverlayData] = React.useState<{
    whiteBotName: string;
    blackBotName: string;
    mapName?: string;
  } | null>(null);
  const liveSubRef = React.useRef<{ disconnect: () => void } | null>(null);
  const lastCelebratedTurnRef = React.useRef<number>(-1);
  // Derive valid tiles set from bitmask
  const validTilesSet = React.useMemo(() => {
    const coords = decodeValidTilesBitmask(
      replay.init.map.width,
      replay.init.map.height,
      replay.init.map.validTilesBitmask
    );
    const set = new Set<string>();
    for (const [x, y] of coords) {
      set.add(`${x},${y}`);
    }
    return set;
  }, [replay]);

  const currentSnapshot = replay.snapshots[currentTurn] || replay.snapshots[0];
  const totalTurns = replay.snapshots.length - 1;

  const replayRef = React.useRef(replay);
  replayRef.current = replay;

  // Victory / Draw audio & confetti celebration trigger
  React.useEffect(() => {
    if (currentTurn >= totalTurns && totalTurns > 0) {
      if (lastCelebratedTurnRef.current !== currentTurn) {
        lastCelebratedTurnRef.current = currentTurn;
        if (currentSnapshot.winner !== undefined) {
          soundManager.playVictory();
          try {
            confetti({
              particleCount: 110,
              spread: 75,
              origin: { y: 0.6 },
            });
          } catch {
            // Ignore if in test env
          }
        } else if (currentSnapshot.isGameOver) {
          soundManager.playDraw();
        }
      }
    } else {
      lastCelebratedTurnRef.current = -1;
    }
  }, [currentTurn, totalTurns, currentSnapshot]);

  // Keyboard shortcuts
  useKeyboardControls({
    onPlayPause: () => {
      soundManager.playClick();
      handlePlayPause();
    },
    onStepPrev: () => {
      soundManager.playClick();
      handleStepPrev();
    },
    onStepNext: () => {
      soundManager.playClick();
      handleStepNext();
    },
    onToggleMute: () => {
      setIsMuted(soundManager.toggleMute());
    },
    onToggleTheater: () => {
      soundManager.playClick();
      setIsTheaterMode((prev) => !prev);
    },
  });
  // Playback timer loop: drives step-by-step match projection
  React.useEffect(() => {
    if (!isPlaying) return;

    const intervalMs = Math.max(30, Math.round(450 / playbackSpeed));
    const timer = setInterval(() => {
      setCurrentTurn((prev) => {
        const maxTurn = replayRef.current.snapshots.length - 1;
        if (prev >= maxTurn) {
          if (!isLiveStream) {
            setIsPlaying(false);
          }
          return prev;
        }
        return prev + 1;
      });
    }, intervalMs);

    return () => clearInterval(timer);
  }, [isPlaying, playbackSpeed, isLiveStream]);

  const handleUploadReplay = (buffer: Uint8Array) => {
    try {
      const parsed = parseReplayBinary(buffer);
      setReplay(parsed);
      setCurrentTurn(0);
      setIsPlaying(true);
    } catch (err) {
      alert(`Failed to load replay file: ${(err as Error).message}`);
    }
  };

  const handlePlayPause = () => {
    if (currentTurn >= totalTurns) {
      setCurrentTurn(0);
      setIsPlaying(true);
    } else {
      setIsPlaying((prev) => !prev);
    }
  };

  const handleStepPrev = () => {
    setIsPlaying(false);
    setCurrentTurn((prev) => Math.max(0, prev - 1));
  };

  const handleStepNext = () => {
    setIsPlaying(false);
    setCurrentTurn((prev) => Math.min(totalTurns, prev + 1));
  };

  const handleSeekTo = (turn: number) => {
    setCurrentTurn(Math.max(0, Math.min(totalTurns, turn)));
  };

  const handlePlaySpecificMatch = async (matchId: string) => {
    try {
      const res = await fetch(`/api/matches/${matchId}/replay`);
      if (res.ok) {
        const arrayBuf = await res.arrayBuffer();
        handleUploadReplay(new Uint8Array(arrayBuf));
        setRightTab('LOGS');
      } else {
        handleMatchStarted(matchId);
      }
    } catch {
      handleMatchStarted(matchId);
    }
  };

  const handleMatchStarted = (matchId: string) => {
    // Disconnect prior stream
    liveSubRef.current?.disconnect();

    setIsLiveStream(true);
    setCurrentTurn(0);
    setIsPlaying(false);

    const sub = subscribeLiveMatch(matchId, {
      onInit: (init, initialReplay) => {
        setReplay(initialReplay);
        setCurrentTurn(0);
        setVersusOverlayData({
          whiteBotName: init.whiteBotName || 'White Bot',
          blackBotName: init.blackBotName || 'Black Bot',
          mapName: init.map.mapName,
        });
      },
      onDelta: (_delta, _snapshot, updatedReplay) => {
        setReplay({ ...updatedReplay });
        if (!versusOverlayData) {
          setIsPlaying(true);
        }
      },
      onEnd: (_end, finishedReplay) => {
        setReplay({ ...finishedReplay });
        setIsLiveStream(false);
      },
      onError: (err) => {
        console.error('Live stream error:', err);
        setIsLiveStream(false);
      },
    });

    liveSubRef.current = sub;
  };

  React.useEffect(() => {
    return () => {
      liveSubRef.current?.disconnect();
    };
  }, []);
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      width: '100vw',
      overflow: 'hidden',
      backgroundColor: '#0b0f19',
    }}>
      {/* Top Header */}
      <Header
        replay={replay}
        currentTurn={currentTurn}
        isLive={isLiveStream}
        isMuted={isMuted}
        isTheaterMode={isTheaterMode}
        onUploadReplay={handleUploadReplay}
        onOpenNewMatch={() => setIsModalOpen(true)}
        onToggleMute={() => setIsMuted(soundManager.toggleMute())}
        onToggleTheater={() => setIsTheaterMode((prev) => !prev)}
      />
      {/* Main Workspace */}
      <div style={{
        display: 'flex',
        flex: 1,
        minHeight: 0,
        position: 'relative',
      }}>
        {/* Left: Canvas 2D Viewport & Timeline */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          minWidth: 0,
          borderRight: '1px solid #1e293b',
        }}>
          <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
            {versusOverlayData && (
              <VersusOverlay
                whiteBotName={versusOverlayData.whiteBotName}
                blackBotName={versusOverlayData.blackBotName}
                mapName={versusOverlayData.mapName}
                onDismiss={() => {
                  setVersusOverlayData(null);
                  setIsPlaying(true);
                }}
              />
            )}
            <CanvasViewport
              boardWidth={replay.init.map.width}
              boardHeight={replay.init.map.height}
              validTiles={validTilesSet}
              whiteThrone={replay.init.map.whiteThrone}
              blackThrone={replay.init.map.blackThrone}
              pieces={currentSnapshot.pieces}
              lastMove={currentSnapshot.lastMove}
            />
          </div>

          <Timeline
            currentTurn={currentTurn}
            totalTurns={totalTurns}
            isPlaying={isPlaying}
            playbackSpeed={playbackSpeed}
            onPlayPause={handlePlayPause}
            onStepPrev={handleStepPrev}
            onStepNext={handleStepNext}
            onSeekTo={handleSeekTo}
            onSpeedChange={setPlaybackSpeed}
          />
        </div>

        {/* Right: Tabbed Control Panel (Bot IDE / Match Logs / ELO Leaderboard) */}
        {!isTheaterMode && (
          <div style={{
            width: '460px',
            display: 'flex',
            flexDirection: 'column',
            padding: '12px',
            gap: '12px',
            backgroundColor: '#0b0f19',
            overflow: 'hidden',
          }}>
          {/* Tabs Navigation */}
          <div style={{
            display: 'flex',
            gap: '4px',
            backgroundColor: '#141d2d',
            padding: '4px',
            borderRadius: '8px',
            border: '1px solid #1e293b',
          }}>
            <button
              onClick={() => setRightTab('LOGS')}
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '6px',
                padding: '6px 10px',
                backgroundColor: rightTab === 'LOGS' ? '#0284c7' : 'transparent',
                color: rightTab === 'LOGS' ? '#ffffff' : '#94a3b8',
                border: 'none',
                borderRadius: '6px',
                fontSize: '12px',
                fontWeight: 700,
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
            >
              <ScrollText size={14} />
              <span>Match Logs</span>
            </button>

            <button
              onClick={() => setRightTab('EDITOR')}
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '6px',
                padding: '6px 10px',
                backgroundColor: rightTab === 'EDITOR' ? '#0284c7' : 'transparent',
                color: rightTab === 'EDITOR' ? '#ffffff' : '#94a3b8',
                border: 'none',
                borderRadius: '6px',
                fontSize: '12px',
                fontWeight: 700,
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
            >
              <Code2 size={14} />
              <span>Bot IDE</span>
            </button>

            <button
              onClick={() => setRightTab('LEADERBOARD')}
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '6px',
                padding: '6px 10px',
                backgroundColor: rightTab === 'LEADERBOARD' ? '#0284c7' : 'transparent',
                color: rightTab === 'LEADERBOARD' ? '#ffffff' : '#94a3b8',
                border: 'none',
                borderRadius: '6px',
                fontSize: '12px',
                fontWeight: 700,
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
            >
              <Trophy size={14} />
              <span>Leaderboard</span>
            </button>
          </div>

          {/* Tab Content */}
          <div style={{ flex: 1, minHeight: 0, display: rightTab === 'EDITOR' ? 'block' : 'none' }}>
            <BotEditor key={user?.id ?? 'anonymous'} onMatchStarted={handleMatchStarted} />
          </div>

          {rightTab === 'LOGS' && (
            <>
              <PieceCounter
                pieces={currentSnapshot.pieces}
                whiteBotName={replay.init.whiteBotName}
                blackBotName={replay.init.blackBotName}
              />
              <div style={{ flex: 1, minHeight: 0 }}>
                <TurnLogs
                  snapshots={replay.snapshots}
                  currentTurn={currentTurn}
                  onSelectTurn={handleSeekTo}
                  onClearLogs={() => {
                    setIsPlaying(false);
                    setCurrentTurn(0);
                  }}
                />
              </div>
            </>
          )}

          {rightTab === 'LEADERBOARD' && (
            <div style={{ flex: 1, minHeight: 0 }}>
              <LeaderboardView
                onChallengeBot={() => setIsModalOpen(true)}
                onOpenCreateTournament={() => setIsTourModalOpen(true)}
                onPlayMatch={handlePlaySpecificMatch}
                initialTournamentId={activeTournamentId}
              />
            </div>
          )}
          </div>
        )}
      </div>

      {/* New Match Modal */}
      <NewMatchModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onMatchStarted={handleMatchStarted}
      />

      {/* Tournament Modal */}
      <TournamentModal
        isOpen={isTourModalOpen}
        onClose={() => setIsTourModalOpen(false)}
        onTournamentStarted={(tourId) => {
          setActiveTournamentId(tourId);
          setRightTab('LEADERBOARD');
        }}
      />
    </div>
  );
};
