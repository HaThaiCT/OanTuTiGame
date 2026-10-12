import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import {
  createMapTopology,
  MapDescriptor,
  WinReason,
  simulateFuzzMatch,
} from '../src/index.js';
import sampleDonut from '../../../docs/specs/maps/sample-donut.map.json';

describe('Determinism Fuzzing Suite (WBS-1.5)', () => {
  const mapDesc = sampleDonut as unknown as MapDescriptor;
  const topology = createMapTopology(mapDesc);

  function sha256(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
  }

  it('executes a single randomized match with full invariant validation', () => {
    const result = simulateFuzzMatch({
      seed: 42,
      map: topology,
      startingPieces: mapDesc.startingPieces,
      maxTurns: 300,
    });

    expect(result.seed).toBe(42);
    expect(result.totalTurns).toBeGreaterThan(0);
    expect([
      WinReason.EXTINCTION,
      WinReason.THRONE_BREACH,
      WinReason.STALEMATE,
      WinReason.MAX_TURNS_DRAW,
    ]).toContain(result.winReason);
    expect(result.canonicalTrace.length).toBeGreaterThan(100);

    const hash = sha256(result.canonicalTrace);
    expect(hash.length).toBe(64);
  });

  it('runs 1,000 randomized matches and proves 100% byte-for-byte SHA-256 determinism', () => {
    const NUM_MATCHES = 1000;
    const START_SEED = 1000000;

    const run1Hashes: string[] = [];
    const run1Results: { winner: number; reason: number; turns: number }[] = [];

    const reasonCounts: Record<number, number> = {
      [WinReason.EXTINCTION]: 0,
      [WinReason.THRONE_BREACH]: 0,
      [WinReason.STALEMATE]: 0,
      [WinReason.MAX_TURNS_DRAW]: 0,
    };

    // ==========================================
    // Run 1: First 1,000 Matches
    // ==========================================
    for (let i = 0; i < NUM_MATCHES; i++) {
      const seed = START_SEED + i;
      const res = simulateFuzzMatch({
        seed,
        map: topology,
        startingPieces: mapDesc.startingPieces,
        maxTurns: 300,
      });

      const hash = sha256(res.canonicalTrace);
      run1Hashes.push(hash);
      run1Results.push({
        winner: res.winner ?? 0,
        reason: res.winReason,
        turns: res.totalTurns,
      });

      if (res.winReason in reasonCounts) {
        reasonCounts[res.winReason]++;
      }
    }

    expect(run1Hashes.length).toBe(NUM_MATCHES);

    // ==========================================
    // Run 2: Re-executing exact same 1,000 Seeds
    // ==========================================
    let matchMismatches = 0;

    for (let i = 0; i < NUM_MATCHES; i++) {
      const seed = START_SEED + i;
      const res = simulateFuzzMatch({
        seed,
        map: topology,
        startingPieces: mapDesc.startingPieces,
        maxTurns: 300,
      });

      const hash = sha256(res.canonicalTrace);

      if (hash !== run1Hashes[i]) {
        matchMismatches++;
      }

      // Check result fields
      expect(res.winner ?? 0).toBe(run1Results[i].winner);
      expect(res.winReason).toBe(run1Results[i].reason);
      expect(res.totalTurns).toBe(run1Results[i].turns);
    }

    // Acceptance Criteria: 100% SHA-256 matches across all 1,000 matches
    expect(matchMismatches).toBe(0);

    // Coverage check: Natural victory conditions occur across randomized matches
    expect(reasonCounts[WinReason.EXTINCTION]).toBeGreaterThan(0);
    expect(reasonCounts[WinReason.THRONE_BREACH]).toBeGreaterThan(0);
  }, 45000);

  it('proves 100% byte-for-byte determinism when MAX_TURNS threshold is triggered', () => {
    const NUM_MATCHES = 100;
    const START_SEED = 2000000;
    const run1Hashes: string[] = [];
    let maxTurnsDrawCount = 0;

    for (let i = 0; i < NUM_MATCHES; i++) {
      const seed = START_SEED + i;
      const res = simulateFuzzMatch({
        seed,
        map: topology,
        startingPieces: mapDesc.startingPieces,
        maxTurns: 15,
      });
      if (res.winReason === WinReason.MAX_TURNS_DRAW) {
        maxTurnsDrawCount++;
      }
      run1Hashes.push(sha256(res.canonicalTrace));
    }

    expect(maxTurnsDrawCount).toBeGreaterThan(0);
    // Re-run and assert 100% SHA-256 match
    for (let i = 0; i < NUM_MATCHES; i++) {
      const seed = START_SEED + i;
      const res = simulateFuzzMatch({
        seed,
        map: topology,
        startingPieces: mapDesc.startingPieces,
        maxTurns: 15,
      });
      expect(sha256(res.canonicalTrace)).toBe(run1Hashes[i]);
    }
  }, 15000);
});
