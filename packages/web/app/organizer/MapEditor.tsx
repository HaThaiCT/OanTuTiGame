'use client';

import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react';
import { apiRequest, errorText } from '../../lib/client';

/* ---------------------------------------------------------------------------------------------
 * Types — mirror `MapDescriptor` / `StartingPieceDescriptor` of `packages/engine/src/graph.ts`.
 * ------------------------------------------------------------------------------------------- */

export type PieceOwner = 'WHITE' | 'BLACK';
export type PieceType = 'ROCK' | 'SCISSORS' | 'PAPER';

export interface EditorPiece {
  id: number;
  owner: PieceOwner;
  type: PieceType;
  pos: [number, number];
}

export interface MapDescriptorDraft {
  mapName: string;
  width: number;
  height: number;
  validTiles: [number, number][];
  whiteThrone: [number, number];
  blackThrone: [number, number];
  startingPieces: EditorPiece[];
}

/** One `maps` row as the picker needs it (`GET /api/v2/maps`). */
export interface MapOption {
  slug: string;
  displayName: string;
  visibility: string;
  currentVersion?: number;
}

export interface ValidationWarning {
  code: string;
  message: string;
}

export interface ValidationReport {
  errors: string[];
  warnings: ValidationWarning[];
}

/* ---------------------------------------------------------------------------------------------
 * Constants — the numeric limits mirror `MapValidator` of the server
 * (`packages/server/src/tournaments/map-validator.ts`).
 * ------------------------------------------------------------------------------------------- */

const MIN_DIMENSION = 3;
const MAX_DIMENSION = 64;
const MAX_TILES = 4096;
const DEFAULT_WIDTH = 8;
const DEFAULT_HEIGHT = 8;
const MIN_CELL_PX = 16;
const MAX_CELL_PX = 36;
const DEFAULT_CELL_PX = 32;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const PIECE_OWNERS: readonly PieceOwner[] = ['WHITE', 'BLACK'];
const PIECE_TYPES: readonly PieceType[] = ['ROCK', 'SCISSORS', 'PAPER'];

const PIECE_OWNER_LABEL: Record<PieceOwner, string> = { WHITE: 'Trắng', BLACK: 'Đen' };
const PIECE_TYPE_LABEL: Record<PieceType, string> = { ROCK: 'Búa', SCISSORS: 'Kéo', PAPER: 'Giấy' };
/** Single-letter glyph drawn inside one grid cell (`Búa / Kéo / Giấy`). */
const PIECE_TYPE_GLYPH: Record<PieceType, string> = { ROCK: 'B', SCISSORS: 'K', PAPER: 'G' };

const TOOLS = [
  { id: 'tiles', label: 'Bật/tắt ô' },
  { id: 'white-throne', label: 'Ngai Trắng' },
  { id: 'black-throne', label: 'Ngai Đen' },
  { id: 'add-piece', label: 'Thêm quân' },
  { id: 'remove-piece', label: 'Xoá quân' },
] as const;

export type ToolId = (typeof TOOLS)[number]['id'];

const TOOL_HINT: Record<ToolId, string> = {
  tiles: 'Bấm hoặc kéo qua các ô để bật/tắt ô hợp lệ.',
  'white-throne': 'Bấm một ô hợp lệ để đặt ngai Trắng; bấm lại đúng ô đó để bỏ ngai.',
  'black-throne': 'Bấm một ô hợp lệ để đặt ngai Đen; bấm lại đúng ô đó để bỏ ngai.',
  'add-piece': 'Bấm một ô hợp lệ còn trống để thêm quân cờ đang chọn.',
  'remove-piece': 'Bấm vào ô có quân cờ để xoá quân đó.',
};

const INPUT_CLASS =
  'h-11 w-full rounded-md border border-[var(--border-control)] bg-[var(--canvas)] px-3 text-[var(--text-primary)] outline-none focus:border-[var(--accent-secondary)]';
const LABEL_CLASS = 'flex flex-col gap-2 text-sm';
const PRIMARY_BUTTON_CLASS =
  'h-11 rounded-md bg-[var(--action)] px-5 font-semibold text-[#0B0D17] disabled:opacity-60';
const SECONDARY_BUTTON_CLASS =
  'h-10 rounded-md border border-[var(--border-control)] px-4 text-sm font-semibold disabled:opacity-60';

const key = (x: number, y: number): string => `${x},${y}`;

/* ---------------------------------------------------------------------------------------------
 * Pure helpers — descriptor <-> editor state, slug suggestion, validation.
 * ------------------------------------------------------------------------------------------- */

/** `Tên giải 7×7` → `ten-giai-7-7`; used to pre-fill the slug while the operator has not typed one. */
export function slugify(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** Every valid tile of a `width`×`height` board, row-major — the order the API receives. */
function collectValidTiles(width: number, height: number, valid: ReadonlySet<string>): [number, number][] {
  const tiles: [number, number][] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (valid.has(key(x, y))) tiles.push([x, y]);
    }
  }
  return tiles;
}

interface DraftInput {
  width: number;
  height: number;
  validTiles: [number, number][];
  whiteThrone: [number, number] | null;
  blackThrone: [number, number] | null;
  startingPieces: EditorPiece[];
}

/**
 * Client mirror of `MapValidator.validate`: same errors (dimensions, tile set, thrones, pieces)
 * and the same three warnings, rendered in Vietnamese so the operator can fix the map before the
 * server is called. Server messages are never replaced — they are rendered verbatim after a save.
 */
export function validateDraft(input: DraftInput): ValidationReport {
  const errors: string[] = [];
  const warnings: ValidationWarning[] = [];
  const { width, height, whiteThrone, blackThrone } = input;

  if (!Number.isInteger(width) || !Number.isInteger(height) || width < MIN_DIMENSION || height < MIN_DIMENSION) {
    errors.push(`Chiều rộng và chiều cao tối thiểu là ${MIN_DIMENSION} ô.`);
  }
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    errors.push(`Chiều rộng và chiều cao tối đa là ${MAX_DIMENSION} ô.`);
  }
  if (Number.isInteger(width) && Number.isInteger(height) && width * height > MAX_TILES) {
    errors.push(`Tổng số ô ${width * height} vượt quá giới hạn ${MAX_TILES} ô.`);
  }

  const tileSet = new Set<string>();
  for (const [x, y] of input.validTiles) {
    if (x < 0 || x >= width || y < 0 || y >= height) {
      errors.push(`Ô [${x}, ${y}] nằm ngoài lưới ${width}×${height}.`);
    }
    const tile = key(x, y);
    if (tileSet.has(tile)) errors.push(`Ô [${x}, ${y}] bị lặp trong danh sách ô hợp lệ.`);
    tileSet.add(tile);
  }
  if (tileSet.size === 0) errors.push('Bản đồ cần ít nhất một ô hợp lệ.');

  if (!whiteThrone) errors.push('Chưa đặt ngai Trắng.');
  else if (!tileSet.has(key(whiteThrone[0], whiteThrone[1]))) {
    errors.push(`Ngai Trắng [${whiteThrone[0]}, ${whiteThrone[1]}] không nằm trên ô hợp lệ.`);
  }
  if (!blackThrone) errors.push('Chưa đặt ngai Đen.');
  else if (!tileSet.has(key(blackThrone[0], blackThrone[1]))) {
    errors.push(`Ngai Đen [${blackThrone[0]}, ${blackThrone[1]}] không nằm trên ô hợp lệ.`);
  }
  if (whiteThrone && blackThrone && whiteThrone[0] === blackThrone[0] && whiteThrone[1] === blackThrone[1]) {
    errors.push('Ngai Trắng và ngai Đen không được trùng nhau.');
  }

  let whitePieces = 0;
  let blackPieces = 0;
  const occupied = new Set<string>();
  for (const piece of input.startingPieces) {
    const [px, py] = piece.pos;
    if (!tileSet.has(key(px, py))) {
      errors.push(`Quân cờ ${piece.id} ở [${px}, ${py}] không nằm trên ô hợp lệ.`);
    }
    if (occupied.has(key(px, py))) errors.push(`Nhiều quân cờ cùng đứng ở ô [${px}, ${py}].`);
    occupied.add(key(px, py));
    if (piece.owner === 'WHITE') whitePieces += 1;
    else blackPieces += 1;

    if (whiteThrone && px === whiteThrone[0] && py === whiteThrone[1]) {
      warnings.push({
        code: 'OCCUPIED_THRONE',
        message: `Ngai Trắng [${px}, ${py}] đã bị quân cờ ${piece.id} (${PIECE_OWNER_LABEL[piece.owner]}) chiếm ngay từ đầu.`,
      });
    }
    if (blackThrone && px === blackThrone[0] && py === blackThrone[1]) {
      warnings.push({
        code: 'OCCUPIED_THRONE',
        message: `Ngai Đen [${px}, ${py}] đã bị quân cờ ${piece.id} (${PIECE_OWNER_LABEL[piece.owner]}) chiếm ngay từ đầu.`,
      });
    }
  }

  if (whitePieces !== blackPieces) {
    warnings.push({
      code: 'UNBALANCED_PIECES',
      message: `Số quân không cân bằng: Trắng có ${whitePieces} quân, Đen có ${blackPieces} quân.`,
    });
  }

  // Mirrors the server: reachability is only meaningful once the descriptor is otherwise valid.
  if (tileSet.size > 0 && errors.length === 0 && whiteThrone) {
    const visited = new Set<string>([key(whiteThrone[0], whiteThrone[1])]);
    const queue: [number, number][] = [[whiteThrone[0], whiteThrone[1]]];
    while (queue.length > 0) {
      const [cx, cy] = queue.shift() as [number, number];
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          if (dx === 0 && dy === 0) continue;
          const tile = key(cx + dx, cy + dy);
          if (tileSet.has(tile) && !visited.has(tile)) {
            visited.add(tile);
            queue.push([cx + dx, cy + dy]);
          }
        }
      }
    }
    if (visited.size < tileSet.size) {
      warnings.push({
        code: 'DISCONNECTED_TILES',
        message: `Bản đồ bị chia cắt: ${tileSet.size - visited.size} ô không tới được từ ngai Trắng.`,
      });
    }
  }

  return { errors, warnings };
}

/** `[x, y]` of an untrusted JSON value, or a Vietnamese error string when the shape is wrong. */
function readPoint(input: unknown, field: string): [number, number] | string {
  if (!Array.isArray(input) || input.length !== 2 || !Number.isInteger(input[0]) || !Number.isInteger(input[1])) {
    return `${field} phải là [x, y] với hai số nguyên.`;
  }
  return [input[0] as number, input[1] as number];
}

/**
 * Parses a pasted descriptor. The editor keeps working on explicit descriptors this way: whatever
 * is applied here is sent back to the API verbatim (tiles, thrones and piece ids included).
 */
export function parseDescriptorJson(raw: string): { descriptor: MapDescriptorDraft } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: 'Descriptor không phải JSON hợp lệ.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'Descriptor phải là một đối tượng JSON.' };
  }
  const record = parsed as Record<string, unknown>;

  const { width, height } = record;
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    return { error: 'width và height phải là số nguyên.' };
  }
  const w = width as number;
  const h = height as number;
  if (w < MIN_DIMENSION || h < MIN_DIMENSION) return { error: `Chiều rộng và chiều cao tối thiểu là ${MIN_DIMENSION}.` };
  if (w > MAX_DIMENSION || h > MAX_DIMENSION) return { error: `Chiều rộng và chiều cao tối đa là ${MAX_DIMENSION}.` };
  if (w * h > MAX_TILES) return { error: `Tổng số ô ${w * h} vượt quá giới hạn ${MAX_TILES} ô.` };

  if (!Array.isArray(record.validTiles)) return { error: 'validTiles phải là một mảng các ô [x, y].' };
  const validTiles: [number, number][] = [];
  const seen = new Set<string>();
  for (const entry of record.validTiles) {
    const point = readPoint(entry, 'Mỗi phần tử của validTiles');
    if (typeof point === 'string') return { error: point };
    if (point[0] < 0 || point[0] >= w || point[1] < 0 || point[1] >= h) {
      return { error: `Ô [${point[0]}, ${point[1]}] nằm ngoài lưới ${w}×${h}.` };
    }
    if (seen.has(key(point[0], point[1]))) return { error: `Ô [${point[0]}, ${point[1]}] bị lặp trong validTiles.` };
    seen.add(key(point[0], point[1]));
    validTiles.push(point);
  }

  const whiteThrone = readPoint(record.whiteThrone, 'whiteThrone');
  if (typeof whiteThrone === 'string') return { error: whiteThrone };
  const blackThrone = readPoint(record.blackThrone, 'blackThrone');
  if (typeof blackThrone === 'string') return { error: blackThrone };

  if (!Array.isArray(record.startingPieces)) return { error: 'startingPieces phải là một mảng.' };
  const startingPieces: EditorPiece[] = [];
  for (const entry of record.startingPieces) {
    if (!entry || typeof entry !== 'object') return { error: 'Mỗi quân cờ phải là một đối tượng JSON.' };
    const piece = entry as Record<string, unknown>;
    if (!Number.isInteger(piece.id)) return { error: 'Mỗi quân cờ cần trường id là số nguyên.' };
    if (typeof piece.owner !== 'string' || !PIECE_OWNERS.includes(piece.owner as PieceOwner)) {
      return { error: `owner của quân cờ ${piece.id} phải là WHITE hoặc BLACK.` };
    }
    if (typeof piece.type !== 'string' || !PIECE_TYPES.includes(piece.type as PieceType)) {
      return { error: `type của quân cờ ${piece.id} phải là ROCK, SCISSORS hoặc PAPER.` };
    }
    const pos = readPoint(piece.pos, `pos của quân cờ ${piece.id}`);
    if (typeof pos === 'string') return { error: pos };
    startingPieces.push({ id: piece.id as number, owner: piece.owner as PieceOwner, type: piece.type as PieceType, pos });
  }

  return {
    descriptor: {
      mapName: typeof record.mapName === 'string' ? record.mapName : '',
      width: w,
      height: h,
      validTiles,
      whiteThrone,
      blackThrone,
      startingPieces,
    },
  };
}

/** Warnings of a `POST …/maps` row or a `POST …/maps/:slug/versions` receipt, kept verbatim. */
function serverWarnings(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  const raw = record.validationWarnings ?? record.validation_warnings;
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    if (entry && typeof entry === 'object') {
      const warning = entry as Record<string, unknown>;
      const code = typeof warning.code === 'string' ? warning.code : '';
      const message = typeof warning.message === 'string' ? warning.message : '';
      if (code !== '' || message !== '') return code === '' ? message : `${code} — ${message}`;
    }
    return JSON.stringify(entry);
  });
}

function asRecord(input: unknown): Record<string, unknown> | null {
  return input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
}

/** `GET /api/v2/maps` rows → picker options; snake_case and camelCase keys are both accepted. */
function normalizeMapOptions(payload: unknown): MapOption[] {
  const record = asRecord(payload);
  const rows = record && Array.isArray(record.maps) ? record.maps : [];
  const options: MapOption[] = [];
  for (const row of rows) {
    const entry = asRecord(row);
    if (!entry) continue;
    const slug = String(entry.slug ?? '');
    if (slug === '') continue;
    const version = entry.currentVersion ?? entry.current_version;
    options.push({
      slug,
      displayName: String(entry.displayName ?? entry.display_name ?? ''),
      visibility: String(entry.visibility ?? 'PUBLIC'),
      currentVersion: typeof version === 'number' ? version : undefined,
    });
  }
  return options;
}

/* ---------------------------------------------------------------------------------------------
 * Component
 * ------------------------------------------------------------------------------------------- */

type Notice = { kind: 'error' | 'success' | 'hint'; text: string };

/** Receipt rendered after a save: the version the server confirmed, plus its warnings verbatim. */
interface SaveResult {
  headline: string;
  slug: string;
  version: number | null;
  warnings: string[];
}

interface MapEditorProps {
  /** Server-loaded `GET /api/v2/maps` rows; refreshed from the browser after every save. */
  initialMaps: MapOption[];
}

function defaultTiles(width: number, height: number): Set<string> {
  const tiles = new Set<string>();
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) tiles.add(key(x, y));
  }
  return tiles;
}

export default function MapEditor({ initialMaps }: MapEditorProps) {
  const [displayName, setDisplayName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [visibility, setVisibility] = useState<'PUBLIC' | 'HIDDEN'>('PUBLIC');

  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [widthDraft, setWidthDraft] = useState(String(DEFAULT_WIDTH));
  const [heightDraft, setHeightDraft] = useState(String(DEFAULT_HEIGHT));
  const [validTiles, setValidTiles] = useState<Set<string>>(() => defaultTiles(DEFAULT_WIDTH, DEFAULT_HEIGHT));
  const [whiteThrone, setWhiteThrone] = useState<[number, number] | null>([0, DEFAULT_HEIGHT - 1]);
  const [blackThrone, setBlackThrone] = useState<[number, number] | null>([DEFAULT_WIDTH - 1, 0]);
  const [pieces, setPieces] = useState<EditorPiece[]>(() => [
    { id: 1, owner: 'WHITE', type: 'ROCK', pos: [1, DEFAULT_HEIGHT - 1] },
    { id: 2, owner: 'BLACK', type: 'SCISSORS', pos: [DEFAULT_WIDTH - 2, 0] },
  ]);

  const [tool, setTool] = useState<ToolId>('tiles');
  const [pieceOwner, setPieceOwner] = useState<PieceOwner>('WHITE');
  const [pieceType, setPieceType] = useState<PieceType>('ROCK');

  const [maps, setMaps] = useState<MapOption[]>(initialMaps);
  const [selectedSlug, setSelectedSlug] = useState('');
  const [descriptorText, setDescriptorText] = useState('');
  /**
   * `mapName` of an imported descriptor. Empty means "name it after the slug", which is what the
   * create path wants; a pasted/loaded descriptor is sent back with its own name untouched.
   */
  const [descriptorName, setDescriptorName] = useState('');

  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [saveResult, setSaveResult] = useState<SaveResult | null>(null);

  const [cellSize, setCellSize] = useState(DEFAULT_CELL_PX);
  const gridContainerRef = useRef<HTMLDivElement | null>(null);
  /** Non-null while a drag is painting tiles: the value every crossed cell is set to. */
  const paintRef = useRef<{ value: boolean } | null>(null);

  async function loadMaps(): Promise<MapOption[]> {
    const result = await apiRequest<unknown>('/api/v2/maps');
    if (!result.ok) return [];
    return normalizeMapOptions(result.data);
  }

  useEffect(() => {
    let cancelled = false;
    void loadMaps().then((loaded) => {
      if (!cancelled && loaded.length > 0) setMaps(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // A whole drag can end outside the grid, so the paint gesture ends on the window, not the cell.
  useEffect(() => {
    const stop = () => {
      paintRef.current = null;
    };
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, []);

  // Cells are capped at MAX_CELL_PX so 64×64 stays scrollable inside its own container; the
  // container width is measured instead of assuming a viewport, since the panel is responsive.
  useEffect(() => {
    const node = gridContainerRef.current;
    if (!node) return;
    const measure = () => {
      const available = node.clientWidth - 4;
      if (available <= 0) return;
      const size = Math.floor(available / width);
      setCellSize(Math.max(MIN_CELL_PX, Math.min(MAX_CELL_PX, size)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [width]);

  const validTileList = collectValidTiles(width, height, validTiles);
  const report = validateDraft({
    width,
    height,
    validTiles: validTileList,
    whiteThrone,
    blackThrone,
    startingPieces: pieces,
  });

  const descriptor: MapDescriptorDraft | null =
    whiteThrone && blackThrone
      ? {
          mapName: descriptorName !== '' ? descriptorName : slug.trim(),
          width,
          height,
          validTiles: validTileList,
          whiteThrone,
          blackThrone,
          startingPieces: pieces,
        }
      : null;

  const pieceByTile = new Map<string, EditorPiece>();
  for (const piece of pieces) pieceByTile.set(key(piece.pos[0], piece.pos[1]), piece);

  const whiteCount = pieces.filter((piece) => piece.owner === 'WHITE').length;
  const blackCount = pieces.length - whiteCount;
  const readOnlyGrid = pending !== null;

  function setTileValid(x: number, y: number, valid: boolean) {
    setValidTiles((current) => {
      const tile = key(x, y);
      if (current.has(tile) === valid) return current;
      const next = new Set(current);
      if (valid) next.add(tile);
      else next.delete(tile);
      return next;
    });
  }

  function resizeGrid(nextWidth: number, nextHeight: number) {
    setValidTiles((current) => {
      const next = new Set<string>();
      for (const tile of current) {
        const [x, y] = tile.split(',').map(Number);
        if (x < nextWidth && y < nextHeight) next.add(tile);
      }
      return next;
    });
    setPieces((current) => current.filter((piece) => piece.pos[0] < nextWidth && piece.pos[1] < nextHeight));
    setWhiteThrone((current) => (current && current[0] < nextWidth && current[1] < nextHeight ? current : null));
    setBlackThrone((current) => (current && current[0] < nextWidth && current[1] < nextHeight ? current : null));
  }

  function applyDimension(raw: string, axis: 'width' | 'height') {
    if (axis === 'width') setWidthDraft(raw);
    else setHeightDraft(raw);
    const parsed = Number(raw.trim());
    if (!Number.isInteger(parsed) || parsed < MIN_DIMENSION || parsed > MAX_DIMENSION) {
      setNotice({
        kind: 'hint',
        text: `Kích thước phải là số nguyên trong khoảng ${MIN_DIMENSION}–${MAX_DIMENSION}; lưới vẫn giữ ${width}×${height}.`,
      });
      return;
    }
    const nextWidth = axis === 'width' ? parsed : width;
    const nextHeight = axis === 'height' ? parsed : height;
    if (nextWidth === width && nextHeight === height) return;
    const dropped = pieces.filter((piece) => piece.pos[0] >= nextWidth || piece.pos[1] >= nextHeight).length;
    setWidth(nextWidth);
    setHeight(nextHeight);
    resizeGrid(nextWidth, nextHeight);
    setNotice(
      dropped > 0
        ? { kind: 'hint', text: `Lưới đổi thành ${nextWidth}×${nextHeight} — đã bỏ ${dropped} quân cờ nằm ngoài lưới mới.` }
        : { kind: 'hint', text: `Lưới đổi thành ${nextWidth}×${nextHeight}.` }
    );
  }

  function applyToolAt(x: number, y: number) {
    const tile = key(x, y);
    const isValid = validTiles.has(tile);
    switch (tool) {
      case 'white-throne': {
        if (!isValid) {
          setNotice({ kind: 'hint', text: `Ô [${x}, ${y}] chưa được bật nên không thể đặt ngai Trắng.` });
          return;
        }
        if (whiteThrone && whiteThrone[0] === x && whiteThrone[1] === y) {
          setWhiteThrone(null);
          setNotice({ kind: 'hint', text: 'Đã bỏ ngai Trắng.' });
          return;
        }
        setWhiteThrone([x, y]);
        if (blackThrone && blackThrone[0] === x && blackThrone[1] === y) {
          setBlackThrone(null);
          setNotice({ kind: 'hint', text: `Ngai Đen đã được bỏ vì ngai Trắng vừa đặt vào ô [${x}, ${y}].` });
          return;
        }
        setNotice(null);
        return;
      }
      case 'black-throne': {
        if (!isValid) {
          setNotice({ kind: 'hint', text: `Ô [${x}, ${y}] chưa được bật nên không thể đặt ngai Đen.` });
          return;
        }
        if (blackThrone && blackThrone[0] === x && blackThrone[1] === y) {
          setBlackThrone(null);
          setNotice({ kind: 'hint', text: 'Đã bỏ ngai Đen.' });
          return;
        }
        setBlackThrone([x, y]);
        if (whiteThrone && whiteThrone[0] === x && whiteThrone[1] === y) {
          setWhiteThrone(null);
          setNotice({ kind: 'hint', text: `Ngai Trắng đã được bỏ vì ngai Đen vừa đặt vào ô [${x}, ${y}].` });
          return;
        }
        setNotice(null);
        return;
      }
      case 'add-piece': {
        if (!isValid) {
          setNotice({ kind: 'hint', text: `Ô [${x}, ${y}] chưa được bật nên không thể thêm quân cờ.` });
          return;
        }
        const existing = pieceByTile.get(tile);
        if (existing) {
          setNotice({ kind: 'hint', text: `Ô [${x}, ${y}] đã có quân cờ ${existing.id}.` });
          return;
        }
        const nextId = pieces.reduce((max, piece) => Math.max(max, piece.id), 0) + 1;
        setPieces((current) => [...current, { id: nextId, owner: pieceOwner, type: pieceType, pos: [x, y] }]);
        setNotice(null);
        return;
      }
      case 'remove-piece': {
        const existing = pieceByTile.get(tile);
        if (!existing) {
          setNotice({ kind: 'hint', text: `Ô [${x}, ${y}] không có quân cờ nào.` });
          return;
        }
        removePiece(existing.id);
        return;
      }
      default:
        return;
    }
  }

  function removePiece(id: number) {
    setPieces((current) => current.filter((piece) => piece.id !== id));
  }

  function fillGrid() {
    setValidTiles(defaultTiles(width, height));
    setNotice({ kind: 'hint', text: 'Đã bật toàn bộ lưới.' });
  }

  function clearGrid() {
    setValidTiles(new Set());
    setWhiteThrone(null);
    setBlackThrone(null);
    setPieces([]);
    setNotice({ kind: 'hint', text: 'Đã xoá lưới: ô hợp lệ, ngai và quân cờ.' });
  }

  function handleCellPointerDown(event: ReactPointerEvent<HTMLButtonElement>, x: number, y: number) {
    if (readOnlyGrid || tool !== 'tiles') return;
    event.preventDefault();
    const value = !validTiles.has(key(x, y));
    paintRef.current = { value };
    setTileValid(x, y, value);
  }

  function handleGridPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const paint = paintRef.current;
    // Touch pointers keep native panning (a 64×64 grid scrolls inside its container); a tap still
    // toggles the cell, while mouse/pen drags paint every crossed cell.
    if (!paint || readOnlyGrid || tool !== 'tiles' || event.pointerType === 'touch') return;
    const element = document.elementFromPoint(event.clientX, event.clientY);
    const cell = element instanceof HTMLElement ? element.closest<HTMLElement>('[data-cell]') : null;
    if (!cell) return;
    const x = Number(cell.dataset.x);
    const y = Number(cell.dataset.y);
    if (!Number.isInteger(x) || !Number.isInteger(y)) return;
    setTileValid(x, y, paint.value);
  }

  function applyDescriptor(input: MapDescriptorDraft, source: string) {
    setWidth(input.width);
    setHeight(input.height);
    setWidthDraft(String(input.width));
    setHeightDraft(String(input.height));
    setValidTiles(new Set(input.validTiles.map(([x, y]) => key(x, y))));
    setWhiteThrone(input.whiteThrone);
    setBlackThrone(input.blackThrone);
    setPieces(input.startingPieces);
    setDescriptorName(input.mapName);
    // A descriptor carries its own map name; reuse it as slug while the operator has not typed one.
    if (!slugTouched && input.mapName !== '') {
      setSlug(SLUG_PATTERN.test(input.mapName) ? input.mapName : slugify(input.mapName));
    }
    setNotice({ kind: 'hint', text: `Đã nạp descriptor từ ${source}.` });
  }

  function importDescriptorText() {
    const parsed = parseDescriptorJson(descriptorText);
    if ('error' in parsed) {
      setNotice({ kind: 'error', text: parsed.error });
      return;
    }
    applyDescriptor(parsed.descriptor, 'ô JSON');
  }

  function dumpDescriptor() {
    if (!descriptor) {
      setNotice({ kind: 'error', text: 'Cần đặt đủ hai ngai trước khi xuất descriptor.' });
      return;
    }
    setDescriptorText(JSON.stringify(descriptor, null, 2));
    setNotice({ kind: 'hint', text: 'Đã điền descriptor hiện tại của lưới vào ô JSON.' });
  }

  async function refreshMapList() {
    const loaded = await loadMaps();
    if (loaded.length > 0 || maps.length === 0) setMaps(loaded);
  }

  /** Both save paths share the same pre-flight: a valid descriptor plus a usable slug. */
  function preflight(): MapDescriptorDraft | null {
    setSaveResult(null);
    if (report.errors.length > 0) {
      setNotice({ kind: 'error', text: report.errors[0] });
      return null;
    }
    if (!descriptor) {
      setNotice({ kind: 'error', text: 'Cần đặt đủ ngai Trắng và ngai Đen trước khi lưu.' });
      return null;
    }
    return descriptor;
  }

  async function createMap() {
    const trimmedSlug = slug.trim();
    if (trimmedSlug === '') {
      setNotice({ kind: 'error', text: 'Cần nhập slug của bản đồ.' });
      return;
    }
    if (!SLUG_PATTERN.test(trimmedSlug)) {
      setNotice({ kind: 'error', text: 'Slug chỉ gồm chữ thường, chữ số và dấu gạch ngang (ví dụ: arena-7x7).' });
      return;
    }
    if (displayName.trim() === '') {
      setNotice({ kind: 'error', text: 'Cần nhập tên hiển thị của bản đồ.' });
      return;
    }
    const payload = preflight();
    if (!payload) return;

    setPending('create-map');
    const result = await apiRequest<Record<string, unknown>>('/api/v2/organizer/maps', {
      method: 'POST',
      body: { slug: trimmedSlug, displayName: displayName.trim(), descriptor: payload, visibility },
    });
    setPending(null);
    if (!result.ok) {
      setNotice({ kind: 'error', text: errorText(result, 'Tạo bản đồ thất bại.') });
      return;
    }
    const confirmedSlug = typeof result.data?.slug === 'string' ? result.data.slug : trimmedSlug;
    const confirmedVersion = typeof result.data?.currentVersion === 'number' ? result.data.currentVersion : null;
    const warnings = serverWarnings(result.data);
    setNotice({
      kind: 'success',
      text: `Server đã tạo bản đồ “${confirmedSlug}”${confirmedVersion !== null ? ` ở phiên bản v${confirmedVersion}` : ''}.`,
    });
    setSaveResult({ headline: 'Tạo bản đồ — server đã xác nhận', slug: confirmedSlug, version: confirmedVersion, warnings });
    setSelectedSlug(confirmedSlug);
    await refreshMapList();
  }

  async function publishVersion() {
    const target = selectedSlug.trim();
    if (target === '') {
      setNotice({ kind: 'error', text: 'Chọn một bản đồ đã có trước khi xuất bản phiên bản mới.' });
      return;
    }
    const payload = preflight();
    if (!payload) return;

    setPending('publish-version');
    const result = await apiRequest<Record<string, unknown>>(
      `/api/v2/organizer/maps/${encodeURIComponent(target)}/versions`,
      { method: 'POST', body: { descriptor: payload } }
    );
    setPending(null);
    if (!result.ok) {
      setNotice({ kind: 'error', text: errorText(result, `Xuất bản phiên bản mới cho “${target}” thất bại.`) });
      return;
    }
    const confirmedSlug = typeof result.data?.slug === 'string' ? result.data.slug : target;
    const confirmedVersion = typeof result.data?.version === 'number' ? result.data.version : null;
    const warnings = serverWarnings(result.data);
    setNotice({
      kind: 'success',
      text: `Server đã xuất bản “${confirmedSlug}”${confirmedVersion !== null ? ` phiên bản v${confirmedVersion}` : ''}.`,
    });
    setSaveResult({
      headline: 'Xuất bản phiên bản mới — server đã xác nhận',
      slug: confirmedSlug,
      version: confirmedVersion,
      warnings,
    });
    await refreshMapList();
  }

  async function loadSelectedDescriptor() {
    const target = selectedSlug.trim();
    if (target === '') {
      setNotice({ kind: 'error', text: 'Chọn một bản đồ trước khi nạp descriptor.' });
      return;
    }
    setPending('load-map');
    const result = await apiRequest<Record<string, unknown>>(`/api/v2/maps/${encodeURIComponent(target)}`);
    setPending(null);
    if (!result.ok) {
      setNotice({ kind: 'error', text: errorText(result, `Không đọc được bản đồ “${target}”.`) });
      return;
    }
    const rawDescriptor = result.data?.descriptor;
    if (rawDescriptor === undefined) {
      setNotice({ kind: 'error', text: `Server không trả về descriptor cho bản đồ “${target}”.` });
      return;
    }
    const parsed = parseDescriptorJson(JSON.stringify(rawDescriptor));
    if ('error' in parsed) {
      setNotice({ kind: 'error', text: `Descriptor của “${target}” không hợp lệ: ${parsed.error}` });
      return;
    }
    applyDescriptor(parsed.descriptor, `bản đồ “${target}”`);
  }

  function cellClassName(x: number, y: number): string {
    const valid = validTiles.has(key(x, y));
    const isWhiteThrone = whiteThrone?.[0] === x && whiteThrone?.[1] === y;
    const isBlackThrone = blackThrone?.[0] === x && blackThrone?.[1] === y;
    const tile = valid
      ? 'border-[var(--border-subtle)] bg-[var(--surface-subtle)]'
      : 'border-dashed border-[var(--border-subtle)] bg-[var(--canvas)] opacity-40';
    const throne = isWhiteThrone
      ? 'border-2 border-[var(--text-primary)]'
      : isBlackThrone
        ? 'border-2 border-[var(--live-accent)]'
        : 'border';
    return `relative flex items-center justify-center select-none ${tile} ${throne}`;
  }

  function cellLabel(x: number, y: number): string {
    const piece = pieceByTile.get(key(x, y));
    const parts = [`Ô [${x}, ${y}]`, validTiles.has(key(x, y)) ? 'hợp lệ' : 'không hợp lệ'];
    if (whiteThrone?.[0] === x && whiteThrone?.[1] === y) parts.push('ngai Trắng');
    if (blackThrone?.[0] === x && blackThrone?.[1] === y) parts.push('ngai Đen');
    if (piece) parts.push(`quân cờ ${piece.id} (${PIECE_OWNER_LABEL[piece.owner]}, ${PIECE_TYPE_LABEL[piece.type]})`);
    return parts.join(' · ');
  }

  const cells: ReactElement[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const piece = pieceByTile.get(key(x, y));
      const isWhiteThrone = whiteThrone?.[0] === x && whiteThrone?.[1] === y;
      const isBlackThrone = blackThrone?.[0] === x && blackThrone?.[1] === y;
      cells.push(
        <button
          key={key(x, y)}
          type="button"
          data-cell={`${x},${y}`}
          data-x={x}
          data-y={y}
          aria-label={cellLabel(x, y)}
          aria-pressed={validTiles.has(key(x, y))}
          title={cellLabel(x, y)}
          disabled={readOnlyGrid}
          className={cellClassName(x, y)}
          style={{ width: cellSize, height: cellSize, fontSize: Math.max(8, Math.round(cellSize * 0.45)) }}
          onPointerDown={(event) => handleCellPointerDown(event, x, y)}
          onClick={() => {
            if (tool !== 'tiles') applyToolAt(x, y);
          }}
          onKeyDown={(event) => {
            if (tool !== 'tiles' || (event.key !== 'Enter' && event.key !== ' ')) return;
            event.preventDefault();
            setTileValid(x, y, !validTiles.has(key(x, y)));
          }}
        >
          {piece ? (
            <span
              className="flex h-full w-full items-center justify-center rounded-[2px] font-bold"
              style={{
                background: piece.owner === 'WHITE' ? 'var(--text-primary)' : 'var(--canvas)',
                color: piece.owner === 'WHITE' ? 'var(--canvas)' : 'var(--text-primary)',
                border: piece.owner === 'BLACK' ? '1px solid var(--border-control)' : undefined,
              }}
            >
              {PIECE_TYPE_GLYPH[piece.type]}
            </span>
          ) : isWhiteThrone || isBlackThrone ? (
            <span className="font-bold" style={{ color: isWhiteThrone ? 'var(--text-primary)' : 'var(--live-accent)' }}>
              T
            </span>
          ) : null}
        </button>
      );
    }
  }

  const noticeTone =
    notice?.kind === 'error'
      ? 'border-[var(--danger-text)] text-[var(--danger-text)]'
      : notice?.kind === 'success'
        ? 'border-[var(--success-text)] text-[var(--success-text)]'
        : 'border-[var(--border-subtle)] text-[var(--text-secondary)]';

  return (
    <section className="flex min-w-0 flex-col gap-4 rounded-md border border-[var(--border-subtle)] bg-[var(--surface)] p-3 sm:p-4">
      <div>
        <h2 className="text-base font-semibold">Trình tạo bản đồ</h2>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          Bật/tắt ô hợp lệ, đặt hai ngai và các quân cờ khởi đầu. Lưới được gửi lên server nguyên vẹn dưới dạng
          descriptor; cảnh báo của server hiển thị nguyên văn sau khi lưu.
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className={`${LABEL_CLASS} w-24`}>
              <span className="font-medium">Rộng</span>
              <input
                type="number"
                min={MIN_DIMENSION}
                max={MAX_DIMENSION}
                step={1}
                value={widthDraft}
                disabled={readOnlyGrid}
                onChange={(event) => applyDimension(event.target.value, 'width')}
                className={INPUT_CLASS}
              />
            </label>
            <label className={`${LABEL_CLASS} w-24`}>
              <span className="font-medium">Cao</span>
              <input
                type="number"
                min={MIN_DIMENSION}
                max={MAX_DIMENSION}
                step={1}
                value={heightDraft}
                disabled={readOnlyGrid}
                onChange={(event) => applyDimension(event.target.value, 'height')}
                className={INPUT_CLASS}
              />
            </label>
            <button type="button" onClick={fillGrid} disabled={readOnlyGrid} className={SECONDARY_BUTTON_CLASS}>
              Toàn bộ lưới
            </button>
            <button type="button" onClick={clearGrid} disabled={readOnlyGrid} className={SECONDARY_BUTTON_CLASS}>
              Xoá lưới
            </button>
          </div>

          <div className="flex flex-wrap gap-2" role="group" aria-label="Công cụ chỉnh bản đồ">
            {TOOLS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-pressed={tool === entry.id}
                disabled={readOnlyGrid}
                onClick={() => setTool(entry.id)}
                className={`h-10 rounded-md px-3 text-sm font-semibold disabled:opacity-60 ${
                  tool === entry.id
                    ? 'bg-[var(--action)] text-[#0B0D17]'
                    : 'border border-[var(--border-control)] text-[var(--text-primary)]'
                }`}
              >
                {entry.label}
              </button>
            ))}
          </div>

          {tool === 'add-piece' ? (
            <div className="flex flex-wrap items-end gap-3">
              <label className={`${LABEL_CLASS} w-32`}>
                <span className="font-medium">Phe</span>
                <select
                  value={pieceOwner}
                  disabled={readOnlyGrid}
                  onChange={(event) => setPieceOwner(event.target.value as PieceOwner)}
                  className={INPUT_CLASS}
                >
                  {PIECE_OWNERS.map((owner) => (
                    <option key={owner} value={owner}>
                      {PIECE_OWNER_LABEL[owner]}
                    </option>
                  ))}
                </select>
              </label>
              <label className={`${LABEL_CLASS} w-32`}>
                <span className="font-medium">Loại quân</span>
                <select
                  value={pieceType}
                  disabled={readOnlyGrid}
                  onChange={(event) => setPieceType(event.target.value as PieceType)}
                  className={INPUT_CLASS}
                >
                  {PIECE_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {PIECE_TYPE_LABEL[type]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}

          <p className="text-xs text-[var(--text-secondary)]">{TOOL_HINT[tool]}</p>

          <div ref={gridContainerRef} className="min-w-0 overflow-x-auto rounded-sm border border-[var(--border-subtle)] bg-[var(--canvas)] p-2">
            <div
              className="grid w-max select-none"
              style={{
                gridTemplateColumns: `repeat(${width}, ${cellSize}px)`,
                gridAutoRows: `${cellSize}px`,
                gap: 1,
                backgroundColor: 'var(--border-subtle)',
                touchAction: 'pan-x pan-y',
              }}
              onPointerMove={handleGridPointerMove}
            >
              {cells}
            </div>
          </div>

          <p className="text-xs text-[var(--text-secondary)]">
            {width}×{height} · {validTileList.length} ô hợp lệ · Trắng {whiteCount} quân · Đen {blackCount} quân · ngai Trắng{' '}
            {whiteThrone ? `[${whiteThrone[0]}, ${whiteThrone[1]}]` : '—'} · ngai Đen{' '}
            {blackThrone ? `[${blackThrone[0]}, ${blackThrone[1]}]` : '—'}
          </p>
          <p className="text-xs text-[var(--text-secondary)]">
            Ký hiệu: <span className="font-mono">T</span> = ngai · <span className="font-mono">B</span> = Búa ·{' '}
            <span className="font-mono">K</span> = Kéo · <span className="font-mono">G</span> = Giấy. Quân Trắng nền sáng, quân
            Đen nền tối.
          </p>

          <div className="rounded-md border border-[var(--border-subtle)]">
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <span className="text-sm font-semibold">Quân cờ khởi đầu</span>
              <span className="text-xs text-[var(--text-secondary)]">
                {pieces.length} quân · Trắng {whiteCount} · Đen {blackCount}
              </span>
            </div>
            {pieces.length === 0 ? (
              <p className="border-t border-[var(--border-subtle)] px-4 py-4 text-sm text-[var(--text-secondary)]">
                Chưa có quân cờ nào. Chọn công cụ “Thêm quân”, chọn phe và loại quân rồi bấm vào một ô hợp lệ còn trống.
              </p>
            ) : (
              <ul className="divide-y divide-[var(--border-subtle)] border-t border-[var(--border-subtle)]">
                {pieces.map((piece) => (
                  <li key={piece.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
                    <span className="font-mono text-xs">id {piece.id}</span>
                    <span className="min-w-0">
                      {PIECE_OWNER_LABEL[piece.owner]} · {PIECE_TYPE_LABEL[piece.type]} · ô [{piece.pos[0]}, {piece.pos[1]}]
                    </span>
                    <button
                      type="button"
                      disabled={readOnlyGrid}
                      onClick={() => removePiece(piece.id)}
                      className="h-8 rounded-md border border-[var(--border-control)] px-3 text-xs font-semibold disabled:opacity-60"
                    >
                      Xoá
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-4 rounded-md border border-[var(--border-subtle)] bg-[var(--canvas)] p-3">
          <label className={LABEL_CLASS}>
            <span className="font-medium">Tên hiển thị</span>
            <input
              value={displayName}
              disabled={readOnlyGrid}
              placeholder="Arena 8×8"
              onChange={(event) => {
                const next = event.target.value;
                setDisplayName(next);
                if (!slugTouched) setSlug(slugify(next));
              }}
              className={INPUT_CLASS}
            />
          </label>
          <label className={LABEL_CLASS}>
            <span className="font-medium">Slug</span>
            <input
              value={slug}
              disabled={readOnlyGrid}
              spellCheck={false}
              placeholder="arena-8x8"
              onChange={(event) => {
                setSlugTouched(true);
                setSlug(event.target.value);
              }}
              className={INPUT_CLASS}
            />
            <span className="text-xs text-[var(--text-secondary)]">Tự sinh từ tên hiển thị cho tới khi bạn tự sửa.</span>
          </label>
          <label className={LABEL_CLASS}>
            <span className="font-medium">Hiển thị</span>
            <select
              value={visibility}
              disabled={readOnlyGrid}
              onChange={(event) => setVisibility(event.target.value as 'PUBLIC' | 'HIDDEN')}
              className={INPUT_CLASS}
            >
              <option value="PUBLIC">PUBLIC — công khai</option>
              <option value="HIDDEN">HIDDEN — ẩn tới khi khóa giải</option>
            </select>
          </label>

          <div className="flex flex-col gap-2 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-4 py-3">
            <span className="text-sm font-semibold">Kiểm tra phía client</span>
            {report.errors.length === 0 ? (
              <p className="text-sm text-[var(--success-text)]">Descriptor hợp lệ theo luật MapValidator.</p>
            ) : (
              <ul className="list-disc pl-5 text-sm text-[var(--danger-text)]">
                {report.errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            )}
            {report.warnings.length > 0 ? (
              <ul className="list-disc pl-5 text-xs text-[var(--warning-text)]">
                {report.warnings.map((warning) => (
                  <li key={`${warning.code}-${warning.message}`}>
                    <span className="font-mono">{warning.code}</span> — {warning.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          <button type="button" onClick={() => void createMap()} disabled={pending !== null} className={PRIMARY_BUTTON_CLASS}>
            {pending === 'create-map' ? 'Đang tạo…' : 'Tạo bản đồ'}
          </button>

          <div className="flex flex-col gap-3 rounded-md border border-[var(--border-subtle)] px-4 py-3">
            <label className={LABEL_CLASS}>
              <span className="font-medium">Bản đồ đã có (GET /api/v2/maps)</span>
              <select
                value={selectedSlug}
                disabled={pending !== null}
                onChange={(event) => setSelectedSlug(event.target.value)}
                className={INPUT_CLASS}
              >
                <option value="">{maps.length === 0 ? 'Chưa có bản đồ nào' : '— chọn bản đồ —'}</option>
                {maps.map((map) => (
                  <option key={map.slug} value={map.slug}>
                    {map.displayName ? `${map.displayName} (${map.slug})` : map.slug}
                    {map.currentVersion !== undefined ? ` · v${map.currentVersion}` : ''}
                    {map.visibility !== 'PUBLIC' ? ` · ${map.visibility}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={pending !== null || selectedSlug === ''}
                onClick={() => void loadSelectedDescriptor()}
                className={SECONDARY_BUTTON_CLASS}
              >
                {pending === 'load-map' ? 'Đang nạp…' : 'Nạp vào lưới'}
              </button>
              <button
                type="button"
                disabled={pending !== null || selectedSlug === ''}
                onClick={() => void publishVersion()}
                className={SECONDARY_BUTTON_CLASS}
              >
                {pending === 'publish-version' ? 'Đang xuất bản…' : 'Xuất bản phiên bản mới'}
              </button>
              <button
                type="button"
                disabled={pending !== null}
                onClick={() => void refreshMapList()}
                className={SECONDARY_BUTTON_CLASS}
              >
                Tải lại danh sách
              </button>
            </div>
            <p className="text-xs text-[var(--text-secondary)]">
              “Xuất bản phiên bản mới” gửi đúng lưới đang hiển thị lên bản đồ đã chọn; bản đồ đã đăng ký sẽ bị server khóa.
            </p>
          </div>

          {notice ? <p className={`rounded-md border px-3 py-2 text-sm ${noticeTone}`}>{notice.text}</p> : null}

          {saveResult ? (
            <div className="flex flex-col gap-2 rounded-md border border-[var(--border-subtle)] px-3 py-2 text-sm">
              <p className="font-semibold">{saveResult.headline}</p>
              <p className="text-xs text-[var(--text-secondary)]">
                slug <span className="font-mono">{saveResult.slug}</span>
                {saveResult.version !== null ? (
                  <>
                    {' '}
                    · phiên bản <span className="font-mono">v{saveResult.version}</span>
                  </>
                ) : null}
              </p>
              {saveResult.warnings.length === 0 ? (
                <p className="text-xs text-[var(--text-secondary)]">Server không trả về cảnh báo nào.</p>
              ) : (
                <ul className="list-disc pl-5 text-xs text-[var(--warning-text)]">
                  {saveResult.warnings.map((warning, index) => (
                    <li key={`${index}-${warning}`} className="font-mono break-words">
                      {warning}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      </div>

      <details className="rounded-md border border-[var(--border-subtle)] px-4 py-3">
        <summary className="cursor-pointer text-sm font-semibold">Descriptor JSON (nâng cao)</summary>
        <div className="mt-3 flex min-w-0 flex-col gap-3">
          <p className="text-xs text-[var(--text-secondary)]">
            Dán một descriptor đầy đủ để nạp vào lưới (giữ nguyên ô hợp lệ, ngai, quân cờ và id), hoặc xuất descriptor hiện tại
            để sao chép.
          </p>
          <textarea
            value={descriptorText}
            spellCheck={false}
            rows={8}
            onChange={(event) => setDescriptorText(event.target.value)}
            placeholder='{"mapName":"arena-8x8","width":8,"height":8,"validTiles":[[0,0]],"whiteThrone":[0,7],"blackThrone":[7,0],"startingPieces":[]}'
            className="w-full rounded-md border border-[var(--border-control)] bg-[var(--canvas)] p-3 font-mono text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent-secondary)]"
          />
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={pending !== null} onClick={importDescriptorText} className={SECONDARY_BUTTON_CLASS}>
              Nạp từ JSON
            </button>
            <button type="button" disabled={pending !== null} onClick={dumpDescriptor} className={SECONDARY_BUTTON_CLASS}>
              Điền descriptor hiện tại
            </button>
          </div>
        </div>
      </details>
    </section>
  );
}
