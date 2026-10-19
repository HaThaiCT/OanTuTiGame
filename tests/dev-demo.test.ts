import { describe, expect, it } from 'vitest';
import { parseDemoArgs } from '../deploy/linux/dev-demo.js';

describe('local demo options', () => {
  it('enables a Rated tournament only when seed explicitly requests it', () => {
    expect(parseDemoArgs(['seed', '--rated', '--format', 'ROUND_ROBIN', '--teams', '4'])).toMatchObject({ command: 'seed', rated: true, format: 'ROUND_ROBIN', teams: 4 });
    expect(parseDemoArgs(['seed']).rated).toBe(false);
    expect(() => parseDemoArgs(['status', '--rated'])).toThrow('--rated is only valid with seed');
  });
});
