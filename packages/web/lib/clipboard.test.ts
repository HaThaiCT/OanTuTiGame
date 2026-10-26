import { afterEach, describe, expect, it } from 'vitest';
import { copyText } from './clipboard';

function stubClipboard(value: { writeText?: (text: string) => Promise<void> } | undefined) {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: value ? { clipboard: value } : {},
  });
}

const originalNavigator = globalThis.navigator;

afterEach(() => {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator });
});

describe('copyText', () => {
  it('rejects the copy on insecure origins without a clipboard instead of pretending success', async () => {
    stubClipboard(undefined);
    await expect(copyText('hello')).resolves.toBe(false);
  });

  it('reports true only when the browser confirms the write', async () => {
    let written = '';
    stubClipboard({ writeText: async (text) => { written = text; } });
    await expect(copyText('HELLO')).resolves.toBe(true);
    expect(written).toBe('HELLO');
  });

  it('surfaces a rejected permission claim as false so callers show the manual-copy fallback', async () => {
    stubClipboard({ writeText: async () => { throw new Error('NotAllowedError'); } });
    await expect(copyText('link')).resolves.toBe(false);
  });
});
