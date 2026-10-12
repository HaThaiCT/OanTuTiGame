import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SoundManager } from '../src/audio/sound-effects.js';

describe('SoundManager Web Audio Synthesizer', () => {
  let soundManager: SoundManager;
  let store: Record<string, string> = {};

  beforeEach(() => {
    store = {};
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, val: string) => { store[key] = val; },
      clear: () => { store = {}; },
    });
    soundManager = new SoundManager();
  });

  it('manages mute state and persists to localStorage', () => {
    expect(soundManager.isMuted()).toBe(false);

    const muted = soundManager.toggleMute();
    expect(muted).toBe(true);
    expect(soundManager.isMuted()).toBe(true);
    expect(localStorage.getItem('oantuti_sound_muted')).toBe('true');

    const unmuted = soundManager.toggleMute();
    expect(unmuted).toBe(false);
    expect(soundManager.isMuted()).toBe(false);
    expect(localStorage.getItem('oantuti_sound_muted')).toBe('false');
  });

  it('safely handles play calls without throwing even in environments with dummy audio', () => {
    expect(() => soundManager.playMove()).not.toThrow();
    expect(() => soundManager.playCapture()).not.toThrow();
    expect(() => soundManager.playVictory()).not.toThrow();
    expect(() => soundManager.playDraw()).not.toThrow();
    expect(() => soundManager.playClick()).not.toThrow();
  });

  it('does not trigger audio output when muted', () => {
    soundManager.toggleMute(); // muted = true
    const spy = vi.spyOn(soundManager, 'playSynthTone');
    soundManager.playMove();
    expect(spy).not.toHaveBeenCalled();
  });
});
