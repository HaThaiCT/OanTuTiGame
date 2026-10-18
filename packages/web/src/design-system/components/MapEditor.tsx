import React, { useState, useMemo } from 'react';
import type { MapDescriptor, StartingPieceDescriptor } from '@oantuti/engine';
import { Button } from './Button.js';
import { Badge } from './Badge.js';
import { Card, CardHeader, CardTitle, CardContent } from './Card.js';

export interface MapEditorProps {
  readonly onSave?: (map: { slug: string; displayName: string; descriptor: MapDescriptor; visibility: 'PUBLIC' | 'HIDDEN' }) => Promise<void>;
}

type EditMode = 'TOGGLE_TILE' | 'SET_WHITE_THRONE' | 'SET_BLACK_THRONE' | 'ADD_WHITE_ROCK' | 'ADD_BLACK_ROCK';

export const MapEditor: React.FC<MapEditorProps> = ({ onSave }) => {
  const [slug, setSlug] = useState('custom-arena-5x5');
  const [displayName, setDisplayName] = useState('Custom Esports Arena');
  const [visibility, setVisibility] = useState<'PUBLIC' | 'HIDDEN'>('PUBLIC');
  const [width, setWidth] = useState(5);
  const [height, setHeight] = useState(5);
  const [mode, setMode] = useState<EditMode>('TOGGLE_TILE');

  const [validTiles, setValidTiles] = useState<Set<string>>(() => {
    const s = new Set<string>();
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) s.add(`${x},${y}`);
    }
    return s;
  });

  const [whiteThrone, setWhiteThrone] = useState<[number, number]>([0, 0]);
  const [blackThrone, setBlackThrone] = useState<[number, number]>([4, 4]);
  const [pieces, setPieces] = useState<StartingPieceDescriptor[]>([
    { id: 1, owner: 'WHITE', type: 'ROCK', pos: [0, 1] },
    { id: 2, owner: 'BLACK', type: 'ROCK', pos: [4, 3] },
  ]);

  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Real-time validation computation
  const validation = useMemo(() => {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!validTiles.has(`${whiteThrone[0]},${whiteThrone[1]}`)) {
      errors.push('White throne is not on a valid tile');
    }
    if (!validTiles.has(`${blackThrone[0]},${blackThrone[1]}`)) {
      errors.push('Black throne is not on a valid tile');
    }
    if (whiteThrone[0] === blackThrone[0] && whiteThrone[1] === blackThrone[1]) {
      errors.push('White and Black thrones cannot occupy the exact same tile');
    }

    let whiteCount = 0;
    let blackCount = 0;
    for (const p of pieces) {
      if (!validTiles.has(`${p.pos[0]},${p.pos[1]}`)) {
        errors.push(`Piece ${p.id} at [${p.pos[0]}, ${p.pos[1]}] is on an invalid tile`);
      }
      if (p.owner === 'WHITE') whiteCount++;
      else blackCount++;

      if (p.pos[0] === whiteThrone[0] && p.pos[1] === whiteThrone[1]) {
        warnings.push(`White throne [${whiteThrone[0]}, ${whiteThrone[1]}] is occupied at game start`);
      }
      if (p.pos[0] === blackThrone[0] && p.pos[1] === blackThrone[1]) {
        warnings.push(`Black throne [${blackThrone[0]}, ${blackThrone[1]}] is occupied at game start`);
      }
    }

    if (whiteCount !== blackCount) {
      warnings.push(`Piece count imbalance: White has ${whiteCount}, Black has ${blackCount}`);
    }

    return { isValid: errors.length === 0, errors, warnings };
  }, [validTiles, whiteThrone, blackThrone, pieces]);

  const handleCellClick = (x: number, y: number) => {
    const key = `${x},${y}`;
    if (mode === 'TOGGLE_TILE') {
      const next = new Set(validTiles);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      setValidTiles(next);
    } else if (mode === 'SET_WHITE_THRONE') {
      setWhiteThrone([x, y]);
    } else if (mode === 'SET_BLACK_THRONE') {
      setBlackThrone([x, y]);
    } else if (mode === 'ADD_WHITE_ROCK') {
      setPieces((prev) => [
        ...prev.filter((p) => !(p.pos[0] === x && p.pos[1] === y)),
        { id: prev.length + 1, owner: 'WHITE', type: 'ROCK', pos: [x, y] },
      ]);
    } else if (mode === 'ADD_BLACK_ROCK') {
      setPieces((prev) => [
        ...prev.filter((p) => !(p.pos[0] === x && p.pos[1] === y)),
        { id: prev.length + 1, owner: 'BLACK', type: 'ROCK', pos: [x, y] },
      ]);
    }
  };

  const handleSave = async () => {
    if (!validation.isValid) {
      alert(`Bản đồ còn lỗi: ${validation.errors.join('; ')}`);
      return;
    }

    const descriptor: MapDescriptor = {
      mapName: slug,
      width,
      height,
      validTiles: Array.from(validTiles).map((k) => k.split(',').map(Number) as [number, number]),
      whiteThrone,
      blackThrone,
      startingPieces: pieces,
    };

    setIsSaving(true);
    try {
      await onSave?.({ slug, displayName, descriptor, visibility });
      setMessage('Lưu bản đồ thành công!');
    } catch (err: any) {
      setMessage(`Lỗi lưu bản đồ: ${err.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Card style={{ maxWidth: '900px', margin: '0 auto' }}>
      <CardHeader>
        <CardTitle>Map Editor (Trình tạo bản đồ trực quan)</CardTitle>
        <div style={{ display: 'flex', gap: '8px' }}>
          <Button variant="primary" size="sm" isLoading={isSaving} onClick={handleSave}>
            Lưu bản đồ
          </Button>
        </div>
      </CardHeader>
      <CardContent style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        {message && (
          <div style={{ padding: '8px 16px', backgroundColor: 'var(--surface-subtle)', borderRadius: '4px', fontSize: '13px' }}>
            {message}
          </div>
        )}

        {/* Form Controls */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
          <div>
            <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Mã Slug:</label>
            <input
              type="text"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              style={{ width: '100%', padding: '6px 8px', backgroundColor: '#0B0D17', color: '#fff', border: '1px solid var(--border-control)', borderRadius: '4px' }}
            />
          </div>
          <div>
            <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Tên hiển thị:</label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              style={{ width: '100%', padding: '6px 8px', backgroundColor: '#0B0D17', color: '#fff', border: '1px solid var(--border-control)', borderRadius: '4px' }}
            />
          </div>
          <div>
            <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Hiển thị:</label>
            <select
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as any)}
              style={{ width: '100%', padding: '6px 8px', backgroundColor: '#0B0D17', color: '#fff', border: '1px solid var(--border-control)', borderRadius: '4px' }}
            >
              <option value="PUBLIC">PUBLIC (Công khai)</option>
              <option value="HIDDEN">HIDDEN (Bảo mật trước khi khóa giải)</option>
            </select>
          </div>
        </div>

        {/* Tools Palette */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
          <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)' }}>Chế độ vẽ:</span>
          {(['TOGGLE_TILE', 'SET_WHITE_THRONE', 'SET_BLACK_THRONE', 'ADD_WHITE_ROCK', 'ADD_BLACK_ROCK'] as EditMode[]).map((m) => (
            <Button
              key={m}
              variant={mode === m ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => setMode(m)}
            >
              {m === 'TOGGLE_TILE' && 'Bật/Tắt Ô'}
              {m === 'SET_WHITE_THRONE' && 'Đặt Ngai Trắng (WT)'}
              {m === 'SET_BLACK_THRONE' && 'Đặt Ngai Đen (BT)'}
              {m === 'ADD_WHITE_ROCK' && '+ Quân Trắng (Búa)'}
              {m === 'ADD_BLACK_ROCK' && '+ Quân Đen (Búa)'}
            </Button>
          ))}
        </div>

        {/* Interactive Grid Canvas */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${width}, 48px)`,
            gridTemplateRows: `repeat(${height}, 48px)`,
            gap: '4px',
            padding: '16px',
            backgroundColor: 'var(--board-bg)',
            borderRadius: '8px',
            width: 'fit-content',
            margin: '0 auto',
            border: '2px solid var(--border-subtle)',
          }}
        >
          {Array.from({ length: height }).map((_, y) =>
            Array.from({ length: width }).map((_, x) => {
              const key = `${x},${y}`;
              const isValid = validTiles.has(key);
              const isWT = whiteThrone[0] === x && whiteThrone[1] === y;
              const isBT = blackThrone[0] === x && blackThrone[1] === y;
              const piece = pieces.find((p) => p.pos[0] === x && p.pos[1] === y);

              return (
                <div
                  key={key}
                  onClick={() => handleCellClick(x, y)}
                  style={{
                    width: '48px',
                    height: '48px',
                    backgroundColor: isValid ? 'var(--board-tile)' : '#070a12',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '12px',
                    fontWeight: 700,
                    userSelect: 'none',
                    color: '#fff',
                    position: 'relative',
                  }}
                  title={`[${x}, ${y}]`}
                >
                  {isWT && <span style={{ color: 'var(--action)' }}>WT</span>}
                  {isBT && <span style={{ color: 'var(--accent-secondary)' }}>BT</span>}
                  {piece && (
                    <span style={{ fontSize: '14px', color: piece.owner === 'WHITE' ? '#fff' : '#888' }}>
                      ✊
                    </span>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Validation Live Feedback */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '13px' }}>
          {validation.errors.length > 0 && (
            <div style={{ color: 'var(--danger-text)' }}>
              <strong>Lỗi:</strong>
              <ul>
                {validation.errors.map((e, idx) => (
                  <li key={idx}>{e}</li>
                ))}
              </ul>
            </div>
          )}
          {validation.warnings.length > 0 && (
            <div style={{ color: 'var(--warning-text)' }}>
              <strong>Cảnh báo (vẫn cho phép thi đấu):</strong>
              <ul>
                {validation.warnings.map((w, idx) => (
                  <li key={idx}>{w}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
};
