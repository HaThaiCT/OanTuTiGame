import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BotLanguage } from '../../packages/protocol/src/index.js';
import type { MapDescriptor } from '../../packages/engine/src/graph.js';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const LANGUAGES: readonly BotLanguage[] = ['PYTHON', 'TYPESCRIPT', 'CPP'];
const TEMPLATE: Record<BotLanguage, { starter: string; sdk: string; entrypoint: string; paths: readonly [string, string]; weights: readonly [string, string, string] }> = {
  PYTHON: { starter: 'sdk/python/starter_bot.py', sdk: 'sdk/python/oantuti.py', entrypoint: 'starter_bot.py', paths: ['starter_bot.py', 'oantuti.py'], weights: ['score += 100000', 'score += 5000', 'dist_delta * 100 - new_dist'] },
  TYPESCRIPT: { starter: 'sdk/typescript/starter_bot.ts', sdk: 'sdk/typescript/oantuti.ts', entrypoint: 'starter_bot.ts', paths: ['starter_bot.ts', 'oantuti.ts'], weights: ['score += 100000', 'score += 5000', 'distDelta * 100 - newDist'] },
  CPP: { starter: 'sdk/cpp/starter_bot.cpp', sdk: 'sdk/cpp/oantuti.hpp', entrypoint: 'starter_bot.cpp', paths: ['starter_bot.cpp', 'oantuti.hpp'], weights: ['score += 100000', 'score += 5000', 'dist_delta * 100 - new_dist'] },
};
const PROFILES: readonly (readonly [number, number, number])[] = [
  [1, 1, 1], [1, 2, 1], [1, 1, 2], [2, 1, 1],
];

function replaceExactlyOnce(source: string, search: string, replacement: string): string {
  const first = source.indexOf(search);
  if (first < 0 || source.indexOf(search, first + search.length) >= 0) {
    throw new Error(`Expected exactly one starter weight occurrence: ${search}`);
  }
  return source.slice(0, first) + replacement + source.slice(first + search.length);
}

export interface ShowcaseBot {
  readonly variant: number;
  readonly language: BotLanguage;
  readonly entrypoint: string;
  readonly files: readonly { readonly path: string; readonly contents: Buffer }[];
}

export function buildShowcaseBot(globalTeamSlot: number): ShowcaseBot {
  if (!Number.isInteger(globalTeamSlot) || globalTeamSlot < 0) throw new Error('globalTeamSlot must be a non-negative integer');
  const variant = globalTeamSlot % 12;
  const language = LANGUAGES[variant % LANGUAGES.length];
  const template = TEMPLATE[language];
  let source = readFileSync(resolve(ROOT, template.starter), 'utf8');
  const profile = PROFILES[Math.floor(variant / 3)];
  const profileIndex = Math.floor(variant / 3);
  if (profileIndex === 1) {
    if (language === 'PYTHON') {
      source = replaceExactlyOnce(source, '        self.enemy_throne = ctx.enemy_throne\n', '        self.enemy_throne = ctx.enemy_throne\n        self.my_throne = ctx.my_throne\n');
      source = replaceExactlyOnce(source, '        self.enemy_throne = (0, 0)\n', '        self.enemy_throne = (0, 0)\n        self.my_throne = (0, 0)\n');
      source = replaceExactlyOnce(source, 'curr_dist = chebyshev_distance(mover.pos, self.enemy_throne)', 'curr_dist = chebyshev_distance(mover.pos, self.my_throne)');
      source = replaceExactlyOnce(source, 'new_dist = chebyshev_distance((tx, ty), self.enemy_throne)', 'new_dist = chebyshev_distance((tx, ty), self.my_throne)');
    } else if (language === 'TYPESCRIPT') {
      source = replaceExactlyOnce(source, '  private enemyThrone: readonly [number, number] = [0, 0];', '  private enemyThrone: readonly [number, number] = [0, 0];\n  private myThrone: readonly [number, number] = [0, 0];');
      source = replaceExactlyOnce(source, '    this.enemyThrone = ctx.enemyThrone;', '    this.enemyThrone = ctx.enemyThrone;\n    this.myThrone = ctx.myThrone;');
      source = replaceExactlyOnce(source, 'chebyshevDistance(mover.x, mover.y, this.enemyThrone[0], this.enemyThrone[1])', 'chebyshevDistance(mover.x, mover.y, this.myThrone[0], this.myThrone[1])');
      source = replaceExactlyOnce(source, 'chebyshevDistance(tx, ty, this.enemyThrone[0], this.enemyThrone[1])', 'chebyshevDistance(tx, ty, this.myThrone[0], this.myThrone[1])');
    } else {
      source = replaceExactlyOnce(source, '    oantuti::Coord enemy_throne_{0, 0};', '    oantuti::Coord enemy_throne_{0, 0};\n    oantuti::Coord my_throne_{0, 0};');
      source = replaceExactlyOnce(source, '        enemy_throne_ = ctx.enemy_throne();', '        enemy_throne_ = ctx.enemy_throne();\n        my_throne_ = ctx.my_throne();');
      source = replaceExactlyOnce(source, 'chebyshev_distance(mover->pos(), enemy_throne_)', 'chebyshev_distance(mover->pos(), my_throne_)');
      source = replaceExactlyOnce(source, 'chebyshev_distance(move.target, enemy_throne_)', 'chebyshev_distance(move.target, my_throne_)');
    }
  } else if (profileIndex === 2) {
    if (language === 'PYTHON') {
      source = replaceExactlyOnce(source, '            score += dist_delta * 100 - new_dist', '            score += dist_delta * 100 - new_dist\n            nearest_enemy_dist = min((chebyshev_distance((tx, ty), enemy.pos) for enemy in ctx.enemy_pieces), default=99)\n            score += (99 - nearest_enemy_dist) * 50');
    } else if (language === 'TYPESCRIPT') {
      source = replaceExactlyOnce(source, '      score += distDelta * 100 - newDist;', '      score += distDelta * 100 - newDist;\n      const nearestEnemyDist = ctx.enemyPieces.reduce((best, enemy) => Math.min(best, chebyshevDistance(tx, ty, enemy.x, enemy.y)), 99);\n      score += (99 - nearestEnemyDist) * 50;');
    } else {
      source = replaceExactlyOnce(source, '            score += dist_delta * 100 - new_dist;', '            score += dist_delta * 100 - new_dist;\n            int nearest_enemy_dist = 99;\n            for (const auto& enemy : ctx.enemy_pieces()) nearest_enemy_dist = std::min(nearest_enemy_dist, oantuti::chebyshev_distance(move.target.x, move.target.y, enemy.x, enemy.y));\n            score += (99 - nearest_enemy_dist) * 50;');
    }
  } else if (profileIndex === 3) {
    if (language === 'PYTHON') source = replaceExactlyOnce(source, '            score = 0', '            score = 0\n            if mover.type == "SCISSORS": score += 1000');
    else if (language === 'TYPESCRIPT') source = replaceExactlyOnce(source, '      let score = 0;', '      let score = 0;\n      if (mover.type === \'SCISSORS\') score += 1000;');
    else source = replaceExactlyOnce(source, '            int score = 0;', '            int score = 0;\n            if (mover->type == "SCISSORS") score += 1000;');
  }
  for (let index = 0; index < template.weights.length; index++) {
    const expression = template.weights[index];
    const match = expression.match(/(\d+)(?!.*\d)/);
    if (!match || match.index === undefined) throw new Error(`Missing numeric strategy weight: ${expression}`);
    const value = String(Number(match[1]) * profile[index]);
    const updated = expression.slice(0, match.index) + value + expression.slice(match.index + match[1].length);
    source = replaceExactlyOnce(source, expression, updated);
  }
  return {
    variant,
    language,
    entrypoint: template.entrypoint,
    files: [
      { path: template.paths[0], contents: Buffer.from(source) },
      { path: template.paths[1], contents: readFileSync(resolve(ROOT, template.sdk)) },
    ],
  };
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createStoredZip(files: ShowcaseBot['files']): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8');
    const data = file.contents;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt16LE(0, 10); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export function buildShowcaseZip(globalTeamSlot: number): { readonly language: BotLanguage; readonly entrypoint: string; readonly zipBuffer: Buffer; readonly variant: number } {
  const bot = buildShowcaseBot(globalTeamSlot);
  return { language: bot.language, entrypoint: bot.entrypoint, zipBuffer: createStoredZip(bot.files), variant: bot.variant };
}

export function buildShowcaseMap(variant: number, tag = 'showcase'): { readonly slug: string; readonly displayName: string; readonly descriptor: MapDescriptor } {
  if (!Number.isInteger(variant) || variant < 0) throw new Error('variant must be a non-negative integer');
  const index = variant % 12;
  const starting = new Set(['0,0','7,7','1,0','0,1','1,1','6,7','7,6','6,6']);
  const obstaclePairs: [number,number][] = [];
  for(let y=0;y<8;y++) for(let x=0;x<8;x++) {
    const mirror=[7-x,7-y] as const;
    if(y*8+x >= mirror[1]*8+mirror[0] || starting.has(`${x},${y}`) || starting.has(`${mirror[0]},${mirror[1]}`)) continue;
    obstaclePairs.push([x,y]);
  }
  const [x,y] = obstaclePairs[index];
  const blocked = new Set<string>(['3,2','4,2','3,5','4,5', `${x},${y}`, `${7-x},${7-y}`]);
  const validTiles: [number,number][] = [];
  for(let y=0;y<8;y++) for(let x=0;x<8;x++) if(!blocked.has(`${x},${y}`)) validTiles.push([x,y]);
  const slug = `${tag.toLowerCase()}-map-${String(index + 1).padStart(2, '0')}`;
  const name = `${tag} Map ${String(index + 1).padStart(2, '0')}`;
  return {
    slug,
    displayName: name,
    descriptor: {
      mapName: name, width: 8, height: 8, validTiles: [...validTiles].sort((a,b)=>a[1]-b[1]||a[0]-b[0]),
      whiteThrone: [0, 0], blackThrone: [7, 7],
      startingPieces: [
        { id: 1, owner: 'WHITE', type: 'ROCK', pos: [1, 0] }, { id: 2, owner: 'WHITE', type: 'SCISSORS', pos: [0, 1] }, { id: 3, owner: 'WHITE', type: 'PAPER', pos: [1, 1] },
        { id: 4, owner: 'BLACK', type: 'ROCK', pos: [6, 7] }, { id: 5, owner: 'BLACK', type: 'SCISSORS', pos: [7, 6] }, { id: 6, owner: 'BLACK', type: 'PAPER', pos: [6, 6] },
      ],
    },
  };
}
