/**
 * Web Audio Procedural Sound Synthesizer for OanTuTi Arena
 * Zero external asset dependencies — synthesizes audio directly in browser.
 */

export class SoundManager {
  private audioCtx: AudioContext | null = null;
  private muted: boolean = false;

  constructor() {
    if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
      this.muted = localStorage.getItem('oantuti_sound_muted') === 'true';
    }
  }

  isMuted(): boolean {
    return this.muted;
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('oantuti_sound_muted', String(this.muted));
    }
    return this.muted;
  }

  private getAudioContext(): AudioContext | null {
    if (this.muted) return null;
    if (typeof window === 'undefined') return null;

    if (!this.audioCtx) {
      const AudioCtxClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtxClass) {
        this.audioCtx = new AudioCtxClass();
      }
    }

    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }

    return this.audioCtx;
  }

  playSynthTone(
    type: OscillatorType,
    startFreq: number,
    endFreq: number,
    durationMs: number,
    gainVolume: number = 0.15
  ): void {
    if (this.muted) return;
    const ctx = this.getAudioContext();
    if (!ctx) return;

    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      const startTime = ctx.currentTime;
      const endTime = startTime + durationMs / 1000;

      osc.type = type;
      osc.frequency.setValueAtTime(startFreq, startTime);
      osc.frequency.exponentialRampToValueAtTime(Math.max(10, endFreq), endTime);

      gain.gain.setValueAtTime(gainVolume, startTime);
      gain.gain.exponentialRampToValueAtTime(0.001, endTime);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(startTime);
      osc.stop(endTime);
    } catch {
      // Ignore audio synthesis errors on unsupported devices
    }
  }

  playMove(): void {
    if (this.muted) return;
    this.playSynthTone('sine', 380, 180, 120, 0.08);
  }

  /**
   * Sound: Heavy bass punch / metallic impact when a piece is captured
   */
  playCapture(): void {
    if (this.muted) return;
    this.playSynthTone('sawtooth', 140, 35, 260, 0.22);
    this.playSynthTone('triangle', 90, 30, 200, 0.18);
  }
  /**
   * Sound: Synthwave victory chime
   */
  playVictory(): void {
    if (this.muted) return;
    const ctx = this.getAudioContext();
    if (!ctx) return;

    const notes = [261.63, 329.63, 392.0, 523.25]; // C4, E4, G4, C5
    notes.forEach((freq, idx) => {
      setTimeout(() => {
        this.playSynthTone('sine', freq, freq * 1.02, 350, 0.12);
      }, idx * 120);
    });
  }

  /**
   * Sound: Neutral draw chime
   */
  playDraw(): void {
    this.playSynthTone('sine', 330, 220, 300, 0.08);
  }

  /**
   * Sound: Crisp tactical UI click
   */
  playClick(): void {
    this.playSynthTone('sine', 600, 800, 40, 0.04);
  }
}

export const soundManager = new SoundManager();
