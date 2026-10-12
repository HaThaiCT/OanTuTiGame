import { describe, it, expect, vi } from 'vitest';
import { handleKeyboardEvent, KeyboardControlHandlers } from '../src/hooks/useKeyboardControls.js';

describe('Keyboard Controls Handler', () => {
  it('dispatches callbacks on valid global keystrokes and prevents default on Space', () => {
    const handlers: KeyboardControlHandlers = {
      onPlayPause: vi.fn(),
      onStepPrev: vi.fn(),
      onStepNext: vi.fn(),
      onToggleMute: vi.fn(),
      onToggleTheater: vi.fn(),
    };

    // Space -> onPlayPause
    const spaceEv = {
      code: 'Space',
      key: ' ',
      target: null,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
    handleKeyboardEvent(spaceEv, handlers);
    expect(handlers.onPlayPause).toHaveBeenCalledTimes(1);
    expect(spaceEv.preventDefault).toHaveBeenCalled();

    // ArrowLeft -> onStepPrev
    const leftEv = {
      code: 'ArrowLeft',
      key: 'ArrowLeft',
      target: null,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
    handleKeyboardEvent(leftEv, handlers);
    expect(handlers.onStepPrev).toHaveBeenCalledTimes(1);

    // ArrowRight -> onStepNext
    const rightEv = {
      code: 'ArrowRight',
      key: 'ArrowRight',
      target: null,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
    handleKeyboardEvent(rightEv, handlers);
    expect(handlers.onStepNext).toHaveBeenCalledTimes(1);

    // KeyM -> onToggleMute
    const mEv = {
      code: 'KeyM',
      key: 'm',
      target: null,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
    handleKeyboardEvent(mEv, handlers);
    expect(handlers.onToggleMute).toHaveBeenCalledTimes(1);

    // KeyF -> onToggleTheater
    const fEv = {
      code: 'KeyF',
      key: 'f',
      target: null,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
    handleKeyboardEvent(fEv, handlers);
    expect(handlers.onToggleTheater).toHaveBeenCalledTimes(1);
  });

  it('ignores keystrokes when typing inside text inputs, textareas, or contentEditable', () => {
    const handlers: KeyboardControlHandlers = {
      onPlayPause: vi.fn(),
      onStepPrev: vi.fn(),
      onStepNext: vi.fn(),
      onToggleMute: vi.fn(),
      onToggleTheater: vi.fn(),
    };

    const mockInput = { tagName: 'INPUT' };
    const spaceEv = {
      code: 'Space',
      key: ' ',
      target: mockInput,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
    handleKeyboardEvent(spaceEv, handlers);
    expect(handlers.onPlayPause).not.toHaveBeenCalled();

    const mockTextarea = { tagName: 'TEXTAREA' };
    const mEv = {
      code: 'KeyM',
      key: 'm',
      target: mockTextarea,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
    handleKeyboardEvent(mEv, handlers);
    expect(handlers.onToggleMute).not.toHaveBeenCalled();
  });
});
