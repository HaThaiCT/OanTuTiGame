import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(import.meta.dirname, '../app/globals.css'), 'utf8');
function theme(name: 'dark' | 'light'): Record<string, string> {
  const selector = name === 'dark' ? /:root,\s*:root\[data-theme='dark'\]\s*\{([^}]*)\}/ : /:root\[data-theme='light'\]\s*\{([^}]*)\}/;
  const block = css.match(selector)?.[1];
  if (!block) throw new Error(`Missing ${name} theme variables`);
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
}
function luminance(hex: string): number {
  const channels = hex.match(/[0-9a-f]{2}/gi)!.map((part) => Number.parseInt(part, 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return channels.reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}
function contrast(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function ratingColor(mode: 'dark' | 'light', rank: string): string {
  const rules = [...css.matchAll(/([^{}]+)\{\s*color:\s*(#[0-9a-f]{3,8}|var\(--[\w-]+\))\s*;\s*\}/gi)];
  for (const [, selector, rawColor] of rules) {
    if (!selector.includes('.rating-name') && !selector.includes('.rating-badge')) continue;
    if (mode === 'light' && !selector.includes(":root[data-theme='light']")) continue;
    if (mode === 'dark' && selector.includes(":root[data-theme='light']")) continue;
    if (!selector.includes(`.rating-${rank}`)) continue;
    const token = /^var\(--([\w-]+)\)$/.exec(rawColor);
    return token ? theme(mode)[token[1]] : rawColor;
  }
  throw new Error(`Missing ${mode} rating color for ${rank}`);
}

describe('theme CSS contracts', () => {
  it('uses a light header surface and readable header text in light mode', () => {
    const light = theme('light');
    expect(light['header-bg']).toContain('255, 255, 255');
    expect(contrast(light['text-primary'], light['surface'])).toBeGreaterThanOrEqual(4.5);
  });
  it('keeps standard secondary text at WCAG AA contrast against every standard surface', () => {
    for (const palette of [theme('dark'), theme('light')]) {
      for (const surface of [palette.canvas, palette.surface, palette['surface-subtle']]) {
        expect(contrast(palette['text-secondary'], surface)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it('uses a contrasting foreground for action buttons in each theme', () => {
    for (const palette of [theme('dark'), theme('light')]) {
      expect(contrast(palette['action-text'], palette.action)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps every rating badge and name color at AA contrast on standard surfaces', () => {
    const ranks = ['unrated', 'newbie', 'pupil', 'specialist', 'expert', 'candidate_master', 'master', 'international_master', 'grandmaster', 'international_grandmaster', 'legendary_grandmaster'];
    for (const [mode, palette] of [['dark', theme('dark')], ['light', theme('light')]] as const) {
      for (const rank of ranks) {
        const color = ratingColor(mode, rank);
        for (const surface of [palette.canvas, palette.surface, palette['surface-subtle']]) {
          expect(contrast(color, surface)).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it('does not animate theme-sensitive colors through low-contrast intermediate values', () => {
    const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    for (const selector of ['.arena-header', '.vct-btn-primary', '.rating-name a']) {
      const body = blocks.find(([, rawSelector]) => rawSelector.replace(/\/\*[\s\S]*?\*\//g, '').split(',').some((item) => item.trim() === selector))?.[2];
      if (!body) throw new Error(`Missing CSS rule for ${selector}`);
      const transitions = [...body.matchAll(/transition(?:-property)?\s*:\s*([^;]+);/gi)].map((match) => match[1]);
      expect(transitions.join(',')).not.toMatch(/(?:^|,)\s*(?:all|color|background|background-color|background-image)(?:\s|,|$)/i);
    }
  });
});
