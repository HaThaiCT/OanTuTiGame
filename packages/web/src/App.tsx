import React from 'react';
import { decodeValidTilesBitmask } from '@oantuti/protocol';
import { Header } from './components/Header.js';
import { Timeline } from './components/Timeline.js';
import { PieceCounter } from './components/PieceCounter.js';
import { TurnLogs } from './components/TurnLogs.js';
import { CanvasViewport } from './components/CanvasViewport.js';
import { NewMatchModal } from './components/NewMatchModal.js';
import { LoadedReplay, parseReplayBinary } from './replay/player.js';
import { generateDefaultMatch } from './replay/mock-generator.js';
import { subscribeLiveMatch } from './api/client.js';
export const App: React.FC = () => {
  const [replay, setReplay] = React.useState<LoadedReplay>(() => generateDefaultMatch());
  const [currentTurn, setCurrentTurn] = React.useState<number>(0);
  const [isPlaying, setIsPlaying] = React.useState<boolean>(false);
  const [playbackSpeed, setPlaybackSpeed] = React.useState<number>(1);
  const [isModalOpen, setIsModalOpen] = React.useState<boolean>(false);
  const [isLiveStream, setIsLiveStream] = React.useState<boolean>(false);
  const liveSubRef = React.useRef<{ disconnect: () => void } | null>(null);
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

  // Playback timer loop
  React.useEffect(() => {
    if (!isPlaying) return;

    const intervalMs = Math.max(30, Math.round(500 / playbackSpeed));
    const timer = setInterval(() => {
      setCurrentTurn((prev) => {
        if (prev >= totalTurns) {
          setIsPlaying(false);
          return prev;
        }
        return prev + 1;
      });
    }, intervalMs);

    return () => clearInterval(timer);
  }, [isPlaying, playbackSpeed, totalTurns]);

  const handleUploadReplay = (buffer: Uint8Array) => {
    try {
      const parsed = parseReplayBinary(buffer);
      setReplay(parsed);
      setCurrentTurn(0);
      setIsPlaying(false);
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

  const handleMatchStarted = (matchId: string) => {
    // Disconnect prior stream
    liveSubRef.current?.disconnect();

    setIsLiveStream(true);
    setIsPlaying(false);

    const sub = subscribeLiveMatch(matchId, {
      onInit: (_init, initialReplay) => {
        setReplay(initialReplay);
        setCurrentTurn(0);
      },
      onDelta: (_delta, _snapshot, updatedReplay) => {
        setReplay({ ...updatedReplay });
        setCurrentTurn(updatedReplay.snapshots.length - 1);
      },
      onEnd: (_end, finishedReplay) => {
        setReplay({ ...finishedReplay });
        setCurrentTurn(finishedReplay.snapshots.length - 1);
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
        onUploadReplay={handleUploadReplay}
        onOpenNewMatch={() => setIsModalOpen(true)}
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

        {/* Right: Heuristic Stats & Turn Logs Panel */}
        <div style={{
          width: '380px',
          display: 'flex',
          flexDirection: 'column',
          padding: '16px',
          gap: '16px',
          backgroundColor: '#0b0f19',
          overflow: 'hidden',
        }}>
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
            />
          </div>
        </div>
      </div>

      {/* New Match Modal */}
      <NewMatchModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onMatchStarted={handleMatchStarted}
      />
    </div>
  );
};
