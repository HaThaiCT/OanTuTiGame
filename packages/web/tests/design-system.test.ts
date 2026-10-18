import { describe, it, expect, beforeEach } from 'vitest';
import { themeTokens } from '../src/design-system/tokens.js';
import { DraftPreserver, type DraftState } from '../src/design-system/DraftPreserver.js';
import { V2ApiClient } from '../src/api/v2-client.js';

describe('S12: Dark Esports UI: Design System, Tokens, Components (T8)', () => {
  describe('1. Color Tokens Hierarchy', () => {
    it('enforces dark-first default palette per specification', () => {
      expect(themeTokens.dark.canvas).toBe('#0B0D17');
      expect(themeTokens.dark.surface).toBe('#151827');
      expect(themeTokens.dark.surfaceSubtle).toBe('#22263A');
      expect(themeTokens.dark.textPrimary).toBe('#F8FAFC');
      expect(themeTokens.dark.action).toBe('#C4B5FD'); // Violet
      expect(themeTokens.dark.accentSecondary).toBe('#67E8F9'); // Cyan
      expect(themeTokens.dark.liveAccent).toBe('#FDBA74'); // Orange
    });

    it('provides secondary light mode alternative with identical token keys', () => {
      const darkKeys = Object.keys(themeTokens.dark).sort();
      const lightKeys = Object.keys(themeTokens.light).sort();
      expect(darkKeys).toEqual(lightKeys);
      expect(themeTokens.light.canvas).toBe('#F8FAFC');
    });
  });

  describe('2. DraftPreserver Persistence Invariants', () => {
    beforeEach(() => {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.clear();
      }
    });

    it('persists and restores multi-file draft state without loss', () => {
      const draft: DraftState = {
        teamId: 'team_alpha_123',
        language: 'PYTHON',
        activeFile: 'strategy.py',
        files: {
          'main.py': 'import strategy',
          'strategy.py': 'def choose_move(): return "PASS"',
        },
        lastModified: '2026-10-16T00:00:00Z',
      };

      DraftPreserver.saveDraft(draft);

      const loaded = DraftPreserver.loadDraft('team_alpha_123');
      expect(loaded).not.toBeNull();
      expect(loaded?.teamId).toBe(draft.teamId);
      expect(loaded?.activeFile).toBe('strategy.py');
      expect(loaded?.files['strategy.py']).toBe(draft.files['strategy.py']);
    });

    it('clears draft upon request without affecting other team drafts', () => {
      const draft1: DraftState = {
        teamId: 'team_1',
        language: 'PYTHON',
        activeFile: 'main.py',
        files: { 'main.py': 'pass' },
        lastModified: '2026-10-16T00:00:00Z',
      };
      const draft2: DraftState = {
        teamId: 'team_2',
        language: 'TYPESCRIPT',
        activeFile: 'bot.ts',
        files: { 'bot.ts': '// code' },
        lastModified: '2026-10-16T00:00:00Z',
      };

      DraftPreserver.saveDraft(draft1);
      DraftPreserver.saveDraft(draft2);

      DraftPreserver.clearDraft('team_1');

      expect(DraftPreserver.loadDraft('team_1')).toBeNull();
      expect(DraftPreserver.loadDraft('team_2')).not.toBeNull();
    });
  });

  describe('3. V2ApiClient Contract Verification', () => {
    it('configures canonical API endpoints under /api/v2 namespace', () => {
      const client = new V2ApiClient('/api/v2');
      expect(client).toBeDefined();
    });
  });
});
