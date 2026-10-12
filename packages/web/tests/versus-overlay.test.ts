import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VersusOverlay } from '../src/components/VersusOverlay.js';

describe('VersusOverlay Component', () => {
  it('renders bot names, map descriptor, and VS combat badge in markup', () => {
    const html = renderToStaticMarkup(
      React.createElement(VersusOverlay, {
        whiteBotName: 'AlphaBot',
        blackBotName: 'OmegaBot',
        whiteElo: 1350,
        blackElo: 1420,
        mapName: 'Donut Citadel',
        onDismiss: () => {},
      })
    );

    expect(html).toContain('AlphaBot');
    expect(html).toContain('OmegaBot');
    expect(html).toContain('1350');
    expect(html).toContain('1420');
    expect(html).toContain('Donut Citadel');
    expect(html).toContain('VS');
  });

  it('renders default unrated labels when ELO is not provided', () => {
    const html = renderToStaticMarkup(
      React.createElement(VersusOverlay, {
        whiteBotName: 'CustomBot1',
        blackBotName: 'CustomBot2',
        onDismiss: () => {},
      })
    );

    expect(html).toContain('CustomBot1');
    expect(html).toContain('CustomBot2');
    expect(html).toContain('UNRATED');
  });
});
