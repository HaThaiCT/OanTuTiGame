import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChampionOverlay } from '../src/components/ChampionOverlay.js';

describe('ChampionOverlay Component', () => {
  it('renders champion name, points, ELO, and ceremony titles in markup', () => {
    const html = renderToStaticMarkup(
      React.createElement(ChampionOverlay, {
        tournamentName: 'OanTuTi Swiss Battle',
        champion: {
          botId: 'bot_1',
          botName: 'ChampionBot',
          language: 'CPP',
          matchesPlayed: 3,
          wins: 3,
          losses: 0,
          draws: 0,
          points: 9,
          elo: 1450,
        },
        runnerUp: {
          botId: 'bot_2',
          botName: 'RunnerUpBot',
          language: 'PYTHON',
          matchesPlayed: 3,
          wins: 2,
          losses: 1,
          draws: 0,
          points: 6,
          elo: 1380,
        },
        onDismiss: () => {},
      })
    );

    expect(html).toContain('LỄ VINH DANH QUÁN QUÂN');
    expect(html).toContain('ChampionBot');
    expect(html).toContain('1450');
    expect(html).toContain('RunnerUpBot');
    expect(html).toContain('OanTuTi Swiss Battle');
  });
});
