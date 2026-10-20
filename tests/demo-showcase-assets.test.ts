import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { MapValidator } from '../packages/server/src/tournaments/map-validator.js';
import { parseAndValidateZip } from '../packages/server/src/submissions/artifact-store.js';
import { buildShowcaseBot, buildShowcaseMap, buildShowcaseZip } from '../deploy/linux/demo-showcase-assets.js';

describe('showcase bot assets', () => {
  it('cycles three languages and four distinct strategy profiles with source variants', () => {
    const bots = Array.from({ length: 12 }, (_, slot) => buildShowcaseBot(slot));
    expect(bots.map((bot) => bot.language)).toEqual([
      'PYTHON', 'TYPESCRIPT', 'CPP', 'PYTHON', 'TYPESCRIPT', 'CPP',
      'PYTHON', 'TYPESCRIPT', 'CPP', 'PYTHON', 'TYPESCRIPT', 'CPP',
    ]);
    expect(bots.map((bot) => bot.variant)).toEqual(Array.from({ length: 12 }, (_, i) => i));
    for (const language of ['PYTHON', 'TYPESCRIPT', 'CPP'] as const) {
      const variants = bots.filter((bot) => bot.language === language);
      expect(new Set(variants.map((bot) => bot.files[0].contents.toString())).size).toBe(4);
    }
  });

  it('builds stored ZIPs accepted by production intake validation', () => {
    for (let slot = 0; slot < 12; slot++) {
      const zip = buildShowcaseZip(slot);
      const extracted = parseAndValidateZip(zip.zipBuffer, zip.language, zip.entrypoint);
      expect(extracted.files.map((file) => file.path)).toEqual(expect.arrayContaining([zip.entrypoint]));
      expect(extracted.files.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('showcase maps', () => {
  it('provides twelve genuinely distinct symmetric 8x8 topologies that production validation accepts', () => {
    const maps = Array.from({ length: 12 }, (_, variant) => buildShowcaseMap(variant));
    expect(new Set(maps.map(({ descriptor }) => [...descriptor.validTiles].map(([x,y])=>`${x},${y}`).sort().join('|'))).size).toBe(12);
    for (const map of maps) {
      const { descriptor } = map;
      expect(descriptor.width).toBe(8); expect(descriptor.height).toBe(8);
      expect(new MapValidator().validate(descriptor).isValid).toBe(true);
      const mask = new Set(descriptor.validTiles.map(([x,y])=>`${x},${y}`));
      for (const [x,y] of descriptor.validTiles) expect(mask.has(`${7-x},${7-y}`)).toBe(true);
    }
  });
  it('names maps within the requested showcase tag namespace',()=>{expect(buildShowcaseMap(0,'RATING').slug).toBe('rating-map-01');});
});

describe('showcase ESM runtime', () => {
  it('loads assets under the standalone Node ESM loader', () => {
    // Exercise the actual tsx ESM loader rather than Vitest's module transform.
    execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `import('./deploy/linux/demo-showcase-assets.ts').then(({buildShowcaseBot})=>{if(buildShowcaseBot(0).files.length!==2)process.exit(2)})`], { cwd: process.cwd() });
  });
});
